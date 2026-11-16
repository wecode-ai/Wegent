import { mobileOperableDevices } from '@/domain/deviceOrdering'
import { isPhoneLocalDeviceId } from './localRuntime'
import { MobileRuntimeCache, type RuntimeCacheSnapshot } from './runtimeCache'

const empty = (): RuntimeCacheSnapshot => ({
  allDevicesSelected: false,
  devices: [],
  models: [],
  selectedDeviceId: null,
  workByDevice: {},
})

/** Device-owned local history is independent of the currently authorized Backend. */
export class RuntimeSessionCache {
  constructor(
    private readonly local: MobileRuntimeCache | null,
    private readonly cloud: MobileRuntimeCache | null,
    private readonly scope?: string
  ) {}

  private owns(id: string): boolean {
    return isPhoneLocalDeviceId(id) && Boolean(this.scope && id.endsWith(`:${this.scope}`))
  }

  async read(): Promise<RuntimeCacheSnapshot> {
    const [local, cloud] = await Promise.all([
      this.local?.read() ?? empty(),
      this.cloud?.read() ?? empty(),
    ])
    const devices = [
      ...local.devices.filter(row => this.owns(row.device_id)),
      ...cloud.devices.filter(row => !isPhoneLocalDeviceId(row.device_id)),
    ]
    const ids = new Set(mobileOperableDevices(devices).map(row => row.device_id))
    return {
      devices,
      models: cloud.models,
      allDevicesSelected: this.cloud ? cloud.allDevicesSelected : false,
      selectedDeviceId:
        local.selectedDeviceId && ids.has(local.selectedDeviceId)
          ? local.selectedDeviceId
          : cloud.selectedDeviceId,
      workByDevice: Object.fromEntries(
        [
          ...Object.entries(local.workByDevice).filter(([id]) => this.owns(id)),
          ...Object.entries(cloud.workByDevice).filter(([id]) => !isPhoneLocalDeviceId(id)),
        ].filter(([id]) => ids.has(id))
      ),
    }
  }

  async write(snapshot: RuntimeCacheSnapshot): Promise<void> {
    const split = (local: boolean): RuntimeCacheSnapshot => {
      const includes = (id: string) => (local ? this.owns(id) : !isPhoneLocalDeviceId(id))
      return {
        devices: snapshot.devices.filter(row => includes(row.device_id)),
        models: local ? [] : snapshot.models,
        allDevicesSelected: local ? false : snapshot.allDevicesSelected,
        selectedDeviceId:
          snapshot.selectedDeviceId && includes(snapshot.selectedDeviceId)
            ? snapshot.selectedDeviceId
            : null,
        workByDevice: Object.fromEntries(
          Object.entries(snapshot.workByDevice).filter(([id]) => includes(id))
        ),
      }
    }
    await Promise.all([this.local?.write(split(true)), this.cloud?.write(split(false))])
  }
}
