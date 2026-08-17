import type { RemoteDeviceOnboardingExtension } from '@/extensions/remote-device-onboarding-contract'
import {
  RemoteDeviceCommandDetails,
  RemoteDeviceOnboardingNotice,
} from '@wecode/features/remote-device/RemoteDeviceOnboardingDetails'

export const remoteDeviceOnboardingExtension: RemoteDeviceOnboardingExtension = {
  Notice: RemoteDeviceOnboardingNotice,
  CommandDetails: RemoteDeviceCommandDetails,
}
