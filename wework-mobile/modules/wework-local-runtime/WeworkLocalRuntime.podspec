Pod::Spec.new do |s|
  s.name = 'WeworkLocalRuntime'
  s.version = '0.1.0'
  s.summary = 'Account-isolated on-device Wework executor transport'
  s.description = 'Expo transport for the embedded ARM64 Linux runtime and native background work.'
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Wework contributors'
  s.homepage = 'https://github.com/wecode-ai/Wegent'
  s.source = { :git => 'https://github.com/wecode-ai/Wegent.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/**/*.{h,c,swift}'
  s.public_header_files = 'ios/WWRuntime.h'
  s.frameworks = 'UIKit', 'Foundation', 'CoreFoundation'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  # Cloud-only installations remain openable without local runtime artifacts.
  # The native API explicitly reports unsupported until a verified bundle exists.
  vendor = File.join(__dir__, 'vendor')
  if File.exist?(File.join(vendor, 'resources', 'manifest.json'))
    s.source_files = ['ios/**/*.{h,c,swift}', 'vendor/importer/*.c']
    s.libraries = 'sqlite3', 'archive', 'resolv'
    s.resource_bundles = {
      'WeworkLocalRuntimeResources' => ['vendor/resources/**/*']
    }
    s.preserve_paths = ['vendor/include/**/*', 'vendor/lib/*.a']
    # The Linux runtime is device-only. Simulator builds compile the unsupported
    # bridge and must not link iPhoneOS archives into an iOS Simulator binary.
    s.user_target_xcconfig = {
      'LIBRARY_SEARCH_PATHS[sdk=iphoneos*]' => '$(inherited) "$(PODS_ROOT)/../../modules/wework-local-runtime/vendor/lib"',
      'OTHER_LDFLAGS[sdk=iphoneos*]' => '$(inherited) -lish -lish_emu -lfakefs'
    }
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/vendor/include/ish" "$(PODS_TARGET_SRCROOT)/vendor/include/archive"',
      'OTHER_CFLAGS[sdk=iphoneos*]' => '$(inherited) -DWWR_EMBEDDED_ISH=1 -DGUEST_ARM64=1 -DENGINE_ASBESTOS=1 -DISH_JIT=1 -DISH_JIT_NO_EMIT=1 -fblocks',
      'EXCLUDED_SOURCE_FILE_NAMES[sdk=iphonesimulator*]' => 'fakefs.c fchdir.c'
    }
  end
end
