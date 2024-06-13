import {
  ChargeTarget,
  DEFAULT_VEHICLE_STATUS_OPTIONS,
  POSSIBLE_CHARGE_LIMIT_VALUES,
  REGIONS,
} from '../constants';
import {
  DeepPartial,
  EVChargeModeTypes,
  EVPlugTypes,
  FullVehicleStatus,
  RawVehicleStatus,
  VehicleDayTrip,
  VehicleLocation,
  VehicleMonthTrip,
  VehicleMonthlyReport,
  VehicleOdometer,
  VehicleRegisterOptions,
  VehicleStartOptions,
  VehicleStatus,
  VehicleStatusOptions,
  VehicleTargetSOC,
  VehicleWindowsOptions,
} from '../interfaces/common.interfaces';

import got from 'got';
import { AustraliaController } from '../controllers/australia.controller';
import {
  EUDatedDriveHistory,
  EUDriveHistory,
  EUPOIInformation,
  historyDrivingPeriod,
} from '../interfaces/european.interfaces';
import logger from '../logger';
import { ManagedBluelinkyError, manageBluelinkyError } from '../tools/common.tools';
import { addMinutes, celciusToTempCode, parseDate, tempCodeToCelsius } from '../util';
import { Vehicle } from './vehicle';

export default class AustraliaVehicle extends Vehicle {
  public region = REGIONS.AU;
  public serverRates: {
    max: number;
    current: number;
    reset?: Date;
    updatedAt?: Date;
  } = {
    max: -1,
    current: -1,
  };

  constructor(
    public vehicleConfig: VehicleRegisterOptions,
    public controller: AustraliaController
  ) {
    super(vehicleConfig, controller);
    logger.debug(`AU Vehicle ${this.vehicleConfig.id} created`);
  }

  private getVehicleHttpService() {
    return this.controller.getVehicleHttpService(this.vehicleConfig.ccuCCS2ProtocolSupport);
  }

  /**
   *
   * @param config - Vehicle start configuration for the request
   * @returns Promise<string>
   * @remarks - not sure if this supports starting ICE vehicles
   */
  public async start(config: VehicleStartOptions): Promise<string> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/engine`, {
          body: {
            action: 'start',
            hvacType: 0,
            options: {
              defrost: config.defrost,
              heating1: config.heatedFeatures ? 1 : 0,
            },
            tempCode: celciusToTempCode(REGIONS.AU, config.temperature),
            unit: config.unit,
          },
        })
      );
      logger.info(`Climate started for vehicle ${this.vehicleConfig.id}`);
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.start');
    }
  }

  public async stop(): Promise<string> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/engine`, {
          body: {
            action: 'stop',
            hvacType: 0,
            options: {
              defrost: true,
              heating1: 1,
            },
            tempCode: '10H',
            unit: 'C',
          },
        })
      );
      logger.info(`Climate stopped for vehicle ${this.vehicleConfig.id}`);
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.stop');
    }
  }

  public async lock(): Promise<string> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/door`, {
          body: {
            action: 'close',
            deviceId: this.controller.session.deviceId,
          },
        })
      );
      if (response.statusCode === 200) {
        logger.debug(`Vehicle ${this.vehicleConfig.id} locked`);
        return 'Lock successful';
      }
      return 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.lock');
    }
  }

  public async unlock(): Promise<string> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/door`, {
          body: {
            action: 'open',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Vehicle ${this.vehicleConfig.id} unlocked`);
        return 'Unlock successful';
      }

      return 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.unlock');
    }
  }

  public async setWindows(config: VehicleWindowsOptions): Promise<string> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/windowcurtain`, {
          body: config,
        })
      );
      logger.info(`Climate started for vehicle ${this.vehicleConfig.id}`);
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.start');
    }
  }

  public async fullStatus(input: VehicleStatusOptions): Promise<FullVehicleStatus | null> {
    const statusConfig = {
      ...DEFAULT_VEHICLE_STATUS_OPTIONS,
      ...input,
    };

    const http = await this.getVehicleHttpService();

    try {
      const vehicleStatusResponse = this.updateRates(
        statusConfig.refresh
          ? await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/status/latest`)
          : await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/status`)
      );
      const locationResponse = this.updateRates(
        await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/location/park`)
      );
      const odometer = await this.odometer();
      // TODO: make odometer in `FullVehicleStatus` nullable
      if (!odometer) {
        return null;
      }

      this._fullStatus = {
        vehicleLocation: locationResponse.body.resMsg.gpsDetail,
        odometer,
        vehicleStatus: vehicleStatusResponse.body.resMsg,
      };
      return this._fullStatus;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.fullStatus');
    }
  }

  public async status(
    input: VehicleStatusOptions
  ): Promise<VehicleStatus | RawVehicleStatus | null> {
    const statusConfig = {
      ...DEFAULT_VEHICLE_STATUS_OPTIONS,
      ...input,
    };

    const http = await this.getVehicleHttpService();

    try {
      const cacheString = statusConfig.refresh ? '' : '/latest';
      const vehicleUrl = this.vehicleConfig.ccuCCS2ProtocolSupport
        ? `/api/v2/spa/vehicles/${this.vehicleConfig.id}/ccs2/carstatus${cacheString}`
        : `/api/v2/spa/vehicles/${this.vehicleConfig.id}/status${cacheString}`;
      const response = this.updateRates(await http.get(vehicleUrl));
      const body = response.body.resMsg;
      if (body == null) {
        throw new Error('missing vehicle status in response');
      }

      const parsedStatus = this.vehicleConfig.ccuCCS2ProtocolSupport
        ? this.parseCCS2VehicleStatus(body)
        : this.parseVehicleStatus(body);

      if (!parsedStatus.engine.range) {
        if (parsedStatus.engine.rangeEV || parsedStatus.engine.rangeGas) {
          parsedStatus.engine.range =
            (parsedStatus.engine.rangeEV ?? 0) + (parsedStatus.engine.rangeGas ?? 0);
        }
      }

      this._status = statusConfig.parsed ? parsedStatus : body;

      return this._status;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.status');
    }
  }

  private parseVehicleStatus(body: any): VehicleStatus {
    return {
      chassis: {
        hoodOpen: body.hoodOpen,
        trunkOpen: body.trunkOpen,
        locked: body.doorLock,
        openDoors: {
          frontRight: !!body.doorOpen?.frontRight,
          frontLeft: !!body.doorOpen?.frontLeft,
          backLeft: !!body.doorOpen?.backLeft,
          backRight: !!body.doorOpen?.backRight,
        },
        tirePressureWarningLamp: {
          rearLeft: !!body.tirePressureLamp?.tirePressureLampRL,
          frontLeft: !!body.tirePressureLamp?.tirePressureLampFL,
          frontRight: !!body.tirePressureLamp?.tirePressureLampFR,
          rearRight: !!body.tirePressureLamp?.tirePressureLampRR,
          all: !!body.tirePressureLamp?.tirePressureWarningLampAll,
        },
      },
      climate: {
        active: body.airCtrlOn,
        steeringwheelHeat: !!body.steerWheelHeat,
        sideMirrorHeat: false,
        rearWindowHeat: !!body.sideBackWindowHeat,
        defrost: body.defrost,
        temperatureSetpoint: tempCodeToCelsius(REGIONS.AU, body.airTemp?.value),
        temperatureUnit: body.airTemp?.unit,
      },
      engine: {
        ignition: body.engine,
        accessory: body.acc,
        rangeGas:
          body.evStatus?.drvDistance[0]?.rangeByFuel?.gasModeRange?.value ?? body.dte?.value,
        // EV
        range: body.evStatus?.drvDistance[0]?.rangeByFuel?.totalAvailableRange?.value,
        rangeEV: body.evStatus?.drvDistance[0]?.rangeByFuel?.evModeRange?.value,
        plugedTo: body.evStatus?.batteryPlugin ?? EVPlugTypes.UNPLUGED,
        charging: body.evStatus?.batteryCharge,
        estimatedCurrentChargeDuration: body.evStatus?.remainTime2?.atc?.value,
        estimatedFastChargeDuration: body.evStatus?.remainTime2?.etc1?.value,
        estimatedPortableChargeDuration: body.evStatus?.remainTime2?.etc2?.value,
        estimatedStationChargeDuration: body.evStatus?.remainTime2?.etc3?.value,
        batteryCharge12v: body.battery?.batSoc,
        batteryChargeHV: body.evStatus?.batteryStatus,
      },
      lastupdate: body.time ? parseDate(body.time) : null,
    };
  }

  private parseCCS2VehicleStatus(body: any): VehicleStatus {
    const vehicleState = body.state?.Vehicle;
    const axle = vehicleState.Chassis?.Axle;
    const door = vehicleState.Cabin?.Door;
    const charging = vehicleState.Green?.ChargingInformation;
    if (!vehicleState || !axle || !door) {
      throw new Error('missing vehicle state in vehicle status response');
    }

    return {
      chassis: {
        hoodOpen: vehicleState.Body?.Hood?.Open === 1,
        trunkOpen: vehicleState.Body?.Trunk?.Open === 1,
        locked:
          door.Row1?.Driver?.Lock === 1 &&
          door.Row1?.Passenger?.Lock === 1 &&
          door.Row2?.Left?.Lock === 1 &&
          door.Row2?.Right?.Lock === 1,
        openDoors: {
          frontRight: door.Row1?.Driver?.Open === 1,
          frontLeft: door.Row1?.Passenger?.Open === 1,
          backLeft: door.Row2?.Left?.Open === 1,
          backRight: door.Row2?.Right?.Open === 1,
        },
        tirePressureWarningLamp: {
          rearLeft: axle.Row2?.Left?.Tire?.PressureLow === 1,
          frontLeft: axle.Row1?.Left?.Tire?.PressureLow === 1,
          frontRight: axle.Row1?.Right?.Tire?.PressureLow === 1,
          rearRight: axle.Row2?.Right?.Tire?.PressureLow === 1,
          all: axle.Tire?.PressureLow === 1,
        },
      },
      climate: {
        active: vehicleState.Cabin?.HVAC?.Row1?.Driver?.Blower?.SpeedLevel !== 0, // `active` is based on whether the driver AC is enabled or not.
        steeringwheelHeat: vehicleState.Cabin?.SteeringWheel?.Heat?.State === 1,
        sideMirrorHeat: false, // TODO: find what property this comes from
        rearWindowHeat: false, // TODO: find what property this comes from
        defrost: false, // TODO: find what property this comes from. Cabin.Body.Windshield.Front.Defog.State doesn't seem to exist.
        temperatureSetpoint: vehicleState.Cabin?.HVAC?.Row1?.Driver?.Temperature?.Value,
        temperatureUnit: vehicleState.Cabin?.HVAC?.Row1?.Driver?.Temperature?.Unit,
      },
      engine: {
        accessory: vehicleState.Electronics?.PowerSupply?.Accessory === 1,
        ignition: vehicleState.Electronics?.PowerSupply?.Ignition1 === 1, // TODO: figure out what Ignition1 vs Ignition3 is
        range: vehicleState.Drivetrain?.FuelSystem?.DTE?.Total, // TODO: what units is `range` expected to be in?
        rangeEV: vehicleState.Drivetrain?.FuelSystem?.DTE?.Total, // TODO: verify that EV vs Gas DTE come from the same property
        rangeGas: vehicleState.Drivetrain?.FuelSystem?.DTE?.Total,
        plugedTo: charging?.ConnectorFastening?.State || EVPlugTypes.UNPLUGED,
        charging: charging?.Charging?.RemainTime > 0,
        estimatedCurrentChargeDuration: charging?.Charging?.RemainTime,
        estimatedStationChargeDuration: charging?.EstimatedTime?.Quick,
        estimatedFastChargeDuration: charging?.EstimatedTime?.Standard, // TODO: verify that "fast" means high voltage AC and "station" means DCFC
        estimatedPortableChargeDuration: charging?.EstimatedTime?.ICCB,
        batteryCharge12v: vehicleState.Electronics?.Battery?.Level,
        batteryChargeHV: vehicleState.Green?.BatteryManagement?.BatteryRemain?.Ratio,
      },
      lastupdate: new Date(body.lastUpdateTime),
    };
  }

  public async odometer(): Promise<VehicleOdometer | null> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/monthlyreport`, {
          body: {
            setRptMonth: toMonthDate({
              year: new Date().getFullYear(),
              month: new Date().getMonth() + 1,
            }),
          },
        })
      );
      this._odometer = {
        // TODO: need to hardcode the unit here: what unit values exist? should this be an enum?
        unit: 0,
        value: response.body.resMsg.odometer,
      };
      return this._odometer;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.odometer');
    }
  }

  public async location(): Promise<VehicleLocation> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/location/park`)
      );

      const data = response.body.resMsg?.gpsDetail;
      this._location = {
        latitude: data?.coord?.lat,
        longitude: data?.coord?.lon,
        altitude: data?.coord?.alt,
        speed: {
          unit: data?.speed?.unit,
          value: data?.speed?.value,
        },
        heading: data?.head,
      };

      return this._location;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.location');
    }
  }

  public async startCharge(): Promise<string> {
    // TODO: test this
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/charge`, {
          body: {
            action: 'start',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Send start charge command to Vehicle ${this.vehicleConfig.id}`);
        return 'Start charge successful';
      }

      throw 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.startCharge');
    }
  }

  public async stopCharge(): Promise<string> {
    // TODO: test this
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/charge`, {
          body: {
            action: 'stop',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Send stop charge command to Vehicle ${this.vehicleConfig.id}`);
        return 'Stop charge successful';
      }

      throw 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.stopCharge');
    }
  }

  public async monthlyReport(
    month: { year: number; month: number } = {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    }
  ): Promise<DeepPartial<VehicleMonthlyReport> | undefined> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/monthlyreport`, {
          body: {
            setRptMonth: toMonthDate(month),
          },
        })
      );
      const rawData = response.body.resMsg?.monthlyReport;
      if (rawData) {
        return {
          start: rawData.ifo?.mvrMonthStart,
          end: rawData.ifo?.mvrMonthEnd,
          breakdown: rawData.breakdown,
          driving: rawData.driving
            ? {
                distance: rawData.driving?.runDistance,
                startCount: rawData.driving?.engineStartCount,
                durations: {
                  idle: rawData.driving?.engineIdleTime,
                  drive: rawData.driving?.engineOnTime,
                },
              }
            : undefined,
          vehicleStatus: rawData.vehicleStatus
            ? {
                tpms: rawData.vehicleStatus?.tpmsSupport
                  ? Boolean(rawData.vehicleStatus?.tpmsSupport)
                  : undefined,
                tirePressure: {
                  all: rawData.vehicleStatus?.tirePressure?.tirePressureLampAll == '1',
                },
              }
            : undefined,
        };
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.monthyReports');
    }
  }

  public async tripInfo(date: {
    year: number;
    month: number;
    day: number;
  }): Promise<DeepPartial<VehicleDayTrip>[] | undefined>;
  public async tripInfo(date?: {
    year: number;
    month: number;
  }): Promise<DeepPartial<VehicleMonthTrip> | undefined>;

  public async tripInfo(
    date: { year: number; month: number; day?: number } = {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    }
  ): Promise<DeepPartial<VehicleDayTrip>[] | DeepPartial<VehicleMonthTrip> | undefined> {
    const http = await this.controller.getApiHttpService();
    try {
      const perDay = Boolean(date.day);
      const response = this.updateRates(
        await http.post(`/api/v1/spa/vehicles/${this.vehicleConfig.id}/tripinfo`, {
          body: {
            setTripLatest: 10,
            setTripMonth: !perDay ? toMonthDate(date) : undefined,
            setTripDay: perDay ? toDayDate(date) : undefined,
            tripPeriodType: perDay ? 1 : 0,
          },
        })
      );

      if (!perDay) {
        const rawData = response.body.resMsg;
        return {
          days: Array.isArray(rawData?.tripDayList)
            ? rawData?.tripDayList.map(day => ({
                dayRaw: day.tripDayInMonth,
                date: day.tripDayInMonth ? parseDate(day.tripDayInMonth) : undefined,
                tripsCount: day.tripCntDay,
              }))
            : [],
          durations: {
            drive: rawData?.tripDrvTime,
            idle: rawData?.tripIdleTime,
          },
          distance: rawData?.tripDist,
          speed: {
            avg: rawData?.tripAvgSpeed,
            max: rawData?.tripMaxSpeed,
          },
        } as VehicleMonthTrip;
      } else {
        const rawData = response.body.resMsg.dayTripList;
        if (rawData && Array.isArray(rawData)) {
          return rawData.map(day => ({
            dayRaw: day.tripDay,
            tripsCount: day.dayTripCnt,
            distance: day.tripDist,
            durations: {
              drive: day.tripDrvTime,
              idle: day.tripIdleTime,
            },
            speed: {
              avg: day.tripAvgSpeed,
              max: day.tripMaxSpeed,
            },
            trips: Array.isArray(day.tripList)
              ? day.tripList.map(trip => {
                  const start = parseDate(`${day.tripDay}${trip.tripTime}`);
                  return {
                    timeRaw: trip.tripTime,
                    start,
                    end: addMinutes(start, trip.tripDrvTime),
                    durations: {
                      drive: trip.tripDrvTime,
                      idle: trip.tripIdleTime,
                    },
                    speed: {
                      avg: trip.tripAvgSpeed,
                      max: trip.tripMaxSpeed,
                    },
                    distance: trip.tripDist,
                  };
                })
              : [],
          }));
        }
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.history');
    }
  }

  public async driveHistory(period: historyDrivingPeriod = historyDrivingPeriod.DAY): Promise<
    DeepPartial<{
      cumulated: EUDriveHistory[];
      history: EUDatedDriveHistory[];
    }>
  > {
    const http = await this.controller.getApiHttpService();
    try {
      const response = await http.post(`/api/v1/spa/vehicles/${this.vehicleConfig.id}/drvhistory`, {
        body: {
          periodTarget: period,
        },
      });
      return {
        cumulated: response.body.resMsg.drivingInfo?.map(line => ({
          period: line.drivingPeriod,
          consumption: {
            total: line.totalPwrCsp,
            engine: line.motorPwrCsp,
            climate: line.climatePwrCsp,
            devices: line.eDPwrCsp,
            battery: line.batteryMgPwrCsp,
          },
          regen: line.regenPwr,
          distance: line.calculativeOdo,
        })),
        history: response.body.resMsg.drivingInfoDetail?.map(line => ({
          period: line.drivingPeriod,
          rawDate: line.drivingDate,
          date: line.drivingDate ? parseDate(line.drivingDate) : undefined,
          consumption: {
            total: line.totalPwrCsp,
            engine: line.motorPwrCsp,
            climate: line.climatePwrCsp,
            devices: line.eDPwrCsp,
            battery: line.batteryMgPwrCsp,
          },
          regen: line.regenPwr,
          distance: line.calculativeOdo,
        })),
      };
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.history');
    }
  }

  /**
   * Warning: Only works on EV
   */
  public async getChargeTargets(): Promise<DeepPartial<VehicleTargetSOC>[] | undefined> {
    const http = await this.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/charge/target`)
      );
      const rawData = response.body.resMsg?.targetSOClist;
      if (rawData && Array.isArray(rawData)) {
        return rawData.map(rawSOC => ({
          distance: rawSOC.drvDistance?.distanceType?.distanceValue,
          targetLevel: rawSOC.targetSOClevel,
          type: rawSOC.plugType,
        }));
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.getChargeTargets');
    }
  }

  /**
   * Warning: Only works on EV
   */
  public async setChargeTargets(limits: { fast: ChargeTarget; slow: ChargeTarget }): Promise<void> {
    // TODO: test this
    const http = await this.getVehicleHttpService();
    if (
      !POSSIBLE_CHARGE_LIMIT_VALUES.includes(limits.fast) ||
      !POSSIBLE_CHARGE_LIMIT_VALUES.includes(limits.slow)
    ) {
      throw new ManagedBluelinkyError(
        `Charge target values are limited to ${POSSIBLE_CHARGE_LIMIT_VALUES.join(', ')}`
      );
    }
    try {
      this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/charge/target`, {
          body: {
            targetSOClist: [
              { plugType: EVChargeModeTypes.FAST, targetSOClevel: limits.fast },
              { plugType: EVChargeModeTypes.SLOW, targetSOClevel: limits.slow },
            ],
          },
        })
      );
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.setChargeTargets');
    }
  }

  /**
   * Define a navigation route
   * @param poiInformations The list of POIs and waypoint to go through
   */
  public async setNavigation(poiInformations: EUPOIInformation[]): Promise<void> {
    // TODO: test this
    const http = await this.getVehicleHttpService();
    try {
      this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/location/routes`, {
          body: {
            deviceID: this.controller.session.deviceId,
            poiInfoList: poiInformations,
          },
        })
      );
    } catch (err) {
      throw manageBluelinkyError(err, 'AustraliaVehicle.setNavigation');
    }
  }

  private updateRates<T extends Record<string, unknown>>(resp: got.Response<T>): got.Response<T> {
    if (resp.headers?.['x-ratelimit-limit']) {
      this.serverRates.max = Number(resp.headers?.['x-ratelimit-limit']);
      this.serverRates.current = Number(resp.headers?.['x-ratelimit-remaining']);
      if (resp.headers?.['x-ratelimit-reset']) {
        this.serverRates.reset = new Date(Number(`${resp.headers?.['x-ratelimit-reset']}000`));
      }
      this.serverRates.updatedAt = new Date();
    }
    return resp;
  }
}

function toMonthDate(month: { year: number; month: number }) {
  return `${month.year}${month.month.toString().padStart(2, '0')}`;
}

function toDayDate(date: { year: number; month: number; day?: number }) {
  return date.day
    ? `${toMonthDate(date)}${date.day.toString().padStart(2, '0')}`
    : toMonthDate(date);
}
