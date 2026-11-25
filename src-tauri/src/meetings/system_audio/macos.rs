// macOS 系统声音采集：Core Audio process tap（macOS 14.4+）。
//
// 流程：CATapDescription（全局立体声、排除本进程）→ AudioHardwareCreateProcessTap
// → 建一个只含该 tap 的私有 aggregate device → 在 aggregate 上挂 IOProc 读输入。
//
// 为什么不用 cpal 0.17 自带的 loopback：它对输出设备先判断 supports_input()，
// USB 耳机 / 部分扩展坞这类「输入输出同一设备」的输出会被直接当成麦克风打开，
// 录到的是耳机麦克风而不是系统声音；而且它不检查 tap 创建的 OSStatus、tap 绑定
// 在开流时的输出设备上（中途插拔耳机就断）。全局 tap 不绑设备，没有这些问题。
//
// 授权：首次 AudioDeviceStart 时系统弹「系统音频录制」授权（文案取 Info.plist 的
// NSAudioCaptureUsageDescription）。被拒时不报错、只给静音——mod.rs 结束时据此
// 打诊断日志。
//
// 为什么 14.4 起：tap API 14.2 引入，但「仅系统音频录制」这条独立 TCC 授权从 14.4
// 才有；更早版本行为不稳定，直接不开，会议降级只录麦克风。

use std::ffi::{CStr, c_void};
use std::ptr::NonNull;

use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_audio::{
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
    CATapMuteBehavior, kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioObjectUnknown, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioTapPropertyFormat,
};
use objc2_core_audio_types::{
    AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp, kAudioFormatFlagIsFloat,
};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

use super::StreamResampler;

const MIN_MACOS: (u32, u32) = (14, 4);

/// IOProc 的私有状态。IOProc 只在 Core Audio 的单个 IO 线程上串行调用，
/// 这里不需要锁；所有权在 Capture 里，Drop 时等 IOProc 撤销后再释放。
struct IoCtx {
    resampler: StreamResampler,
    mono: Vec<f32>,
    out: Vec<f32>,
}

pub(crate) struct Capture {
    tap_id: AudioObjectID,
    aggregate_id: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    ctx: *mut IoCtx,
}

// ctx 只被 IOProc 线程访问，Capture 本身只在 start / drop 时碰它。
unsafe impl Send for Capture {}

impl Capture {
    pub(crate) fn start() -> Result<Self, String> {
        match macos_version() {
            Some(v) if v >= MIN_MACOS => {}
            Some((major, minor)) => {
                return Err(format!(
                    "requires macOS {}.{}+, running {major}.{minor}",
                    MIN_MACOS.0, MIN_MACOS.1
                ));
            }
            None => return Err("cannot determine macOS version".into()),
        }

        // 先建空壳：后续任一步失败直接 return Err，Drop 按已创建的部分回收。
        let mut cap = Capture {
            tap_id: kAudioObjectUnknown,
            aggregate_id: kAudioObjectUnknown,
            proc_id: None,
            ctx: std::ptr::null_mut(),
        };

        // 1) tap：全局立体声混音，排除本进程（不录自己的提示音）。
        let exclude: Vec<Retained<NSNumber>> = own_process_object()
            .map(NSNumber::new_u32)
            .into_iter()
            .collect();
        let exclude = NSArray::from_retained_slice(&exclude);
        let desc = unsafe {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &exclude,
            )
        };
        unsafe {
            desc.setName(&NSString::from_str("OpenSpeech meeting system audio"));
            desc.setPrivate(true);
            // 录的同时照常从扬声器 / 耳机放出来。
            desc.setMuteBehavior(CATapMuteBehavior::Unmuted);
        }
        let status = unsafe { AudioHardwareCreateProcessTap(Some(&desc), &mut cap.tap_id) };
        if status != 0 || cap.tap_id == kAudioObjectUnknown {
            return Err(format!(
                "AudioHardwareCreateProcessTap failed: OSStatus {status}"
            ));
        }
        let tap_uid = unsafe { desc.UUID().UUIDString() };

        // 2) tap 的输出格式（全局立体声 tap 实测为 float32，采样率跟随系统输出）。
        let format = tap_format(cap.tap_id)?;
        if format.mFormatFlags & kAudioFormatFlagIsFloat == 0 || format.mBitsPerChannel != 32 {
            return Err(format!(
                "unsupported tap format: flags={:#x} bits={}",
                format.mFormatFlags, format.mBitsPerChannel
            ));
        }
        log::info!(
            "[sysaudio] tap created id={} sr={}Hz ch={} excluded_self={}",
            cap.tap_id,
            format.mSampleRate,
            format.mChannelsPerFrame,
            exclude.count() > 0
        );

        // 3) 只含这个 tap 的私有 aggregate device（不出现在系统设备列表里）。
        cap.aggregate_id = create_aggregate(&tap_uid)?;

        // 4) IOProc 读输入。
        cap.ctx = Box::into_raw(Box::new(IoCtx {
            resampler: StreamResampler::new(format.mSampleRate.round() as u32),
            mono: Vec::with_capacity(4096),
            out: Vec::with_capacity(2048),
        }));
        let status = unsafe {
            AudioDeviceCreateIOProcID(
                cap.aggregate_id,
                Some(io_proc),
                cap.ctx.cast(),
                NonNull::from(&mut cap.proc_id),
            )
        };
        if status != 0 || cap.proc_id.is_none() {
            return Err(format!(
                "AudioDeviceCreateIOProcID failed: OSStatus {status}"
            ));
        }
        let status = unsafe { AudioDeviceStart(cap.aggregate_id, cap.proc_id) };
        if status != 0 {
            return Err(format!("AudioDeviceStart failed: OSStatus {status}"));
        }
        Ok(cap)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            // AudioDeviceStop / DestroyIOProcID 在非 IO 线程上调用时同步返回，
            // 之后 IOProc 不会再被调用，ctx 才能安全释放。
            if self.proc_id.is_some() {
                AudioDeviceStop(self.aggregate_id, self.proc_id);
                AudioDeviceDestroyIOProcID(self.aggregate_id, self.proc_id);
            }
            if self.aggregate_id != kAudioObjectUnknown {
                AudioHardwareDestroyAggregateDevice(self.aggregate_id);
            }
            if self.tap_id != kAudioObjectUnknown {
                AudioHardwareDestroyProcessTap(self.tap_id);
            }
            if !self.ctx.is_null() {
                drop(Box::from_raw(self.ctx));
            }
        }
    }
}

unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    if client.is_null() {
        return 0;
    }
    let ctx = unsafe { &mut *(client as *mut IoCtx) };
    let abl = input.as_ptr();
    let n_buf = unsafe { (*abl).mNumberBuffers } as usize;
    if n_buf == 0 {
        return 0;
    }
    let bufs = unsafe { std::slice::from_raw_parts((*abl).mBuffers.as_ptr(), n_buf) };

    ctx.mono.clear();
    if n_buf == 1 {
        // 交错：一个 buffer 里 N 声道交替排列。
        let b = &bufs[0];
        if b.mData.is_null() {
            return 0;
        }
        let ch = b.mNumberChannels.max(1) as usize;
        let data = unsafe {
            std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4)
        };
        for frame in data.chunks_exact(ch) {
            ctx.mono.push(frame.iter().sum::<f32>() / ch as f32);
        }
    } else {
        // 非交错：每声道一个 buffer。
        let frames = bufs
            .iter()
            .map(|b| b.mDataByteSize as usize / 4)
            .min()
            .unwrap_or(0);
        let chans: Vec<&[f32]> = bufs
            .iter()
            .filter(|b| !b.mData.is_null())
            .map(|b| unsafe { std::slice::from_raw_parts(b.mData as *const f32, frames) })
            .collect();
        if chans.is_empty() {
            return 0;
        }
        for f in 0..frames {
            ctx.mono
                .push(chans.iter().map(|c| c[f]).sum::<f32>() / chans.len() as f32);
        }
    }

    ctx.out.clear();
    ctx.resampler.process(&ctx.mono, &mut ctx.out);
    super::push_system_16k(&ctx.out);
    0
}

fn property_address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// 本进程对应的 Core Audio process object；进程还没做过音频 IO 时可能不存在，
/// 此时不排除（只是可能录进自己的提示音）。
fn own_process_object() -> Option<AudioObjectID> {
    let pid = std::process::id() as i32;
    let addr = property_address(kAudioHardwarePropertyTranslatePIDToProcessObject);
    let mut obj: AudioObjectID = kAudioObjectUnknown;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&addr),
            std::mem::size_of::<i32>() as u32,
            (&pid as *const i32).cast(),
            NonNull::from(&mut size),
            NonNull::from(&mut obj).cast(),
        )
    };
    (status == 0 && obj != kAudioObjectUnknown).then_some(obj)
}

fn tap_format(tap_id: AudioObjectID) -> Result<AudioStreamBasicDescription, String> {
    let addr = property_address(kAudioTapPropertyFormat);
    // SAFETY: ASBD 是纯 POD 结构体，全零是合法值。
    let mut asbd: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            tap_id,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut asbd).cast(),
        )
    };
    if status != 0 {
        return Err(format!("read tap format failed: OSStatus {status}"));
    }
    Ok(asbd)
}

fn create_aggregate(tap_uid: &NSString) -> Result<AudioObjectID, String> {
    fn key(k: &CStr) -> Retained<NSString> {
        NSString::from_str(k.to_str().unwrap_or_default())
    }
    let yes = NSNumber::new_bool(true);

    let sub_keys = [
        key(kAudioSubTapUIDKey),
        key(kAudioSubTapDriftCompensationKey),
    ];
    let sub_vals: [&AnyObject; 2] = [tap_uid, &yes];
    let sub_tap = NSDictionary::<NSString, AnyObject>::from_slices(
        &[&*sub_keys[0], &*sub_keys[1]],
        &sub_vals,
    );
    let taps = NSArray::from_retained_slice(&[sub_tap]);

    // 每次开会一个新 UID：上一场若异常退出没销毁，私有设备随进程消失，不会撞名。
    let uid = NSString::from_str(&format!("com.openspeech.app.meeting-sysaudio.{tap_uid}"));
    let name = NSString::from_str("OpenSpeech Meeting System Audio");
    let keys = [
        key(kAudioAggregateDeviceNameKey),
        key(kAudioAggregateDeviceUIDKey),
        key(kAudioAggregateDeviceIsPrivateKey),
        key(kAudioAggregateDeviceTapAutoStartKey),
        key(kAudioAggregateDeviceTapListKey),
    ];
    let vals: [&AnyObject; 5] = [&name, &uid, &yes, &yes, &taps];
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let dict = NSDictionary::<NSString, AnyObject>::from_slices(&key_refs, &vals);

    // NSDictionary 与 CFDictionary toll-free bridged。
    let cf: &CFDictionary = unsafe { &*(Retained::as_ptr(&dict) as *const CFDictionary) };
    let mut id: AudioObjectID = kAudioObjectUnknown;
    let status = unsafe { AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut id)) };
    if status != 0 || id == kAudioObjectUnknown {
        return Err(format!(
            "AudioHardwareCreateAggregateDevice failed: OSStatus {status}"
        ));
    }
    Ok(id)
}

/// "15.3.1" → (15, 3)。与 commands.rs 的 macos_major_version 同源（sw_vers），
/// 但这里需要次版本号。
fn macos_version() -> Option<(u32, u32)> {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let mut it = s.trim().split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor))
}
