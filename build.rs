//! 构建期用 rsbinder-aidl 把前台观察相关的 AIDL 编译成 Rust 绑定。
//!
//! - `IUidObserver`：系统侧回调我们的接口（onUidStateChanged 等），事务码与
//!   真实 AOSP `android.app.IUidObserver` 一致（1..=6）。
//! - `IActivityManager`：最小代理，`registerUidObserver` 必须保持在接口第 2 位
//!   （code=2），与真实 IActivityManager 的 native 侧稳定区段一致。

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rerun-if-changed=aidl/android/app/IUidObserver.aidl");
    println!("cargo:rerun-if-changed=aidl/android/app/IActivityManager.aidl");
    // 版本 banner 要嵌短 git hash + 构建时间：切 commit / 打 tag / 改源码后必须
    // 重跑本脚本，否则 banner 里的 hash 与时间会停留在上一次构建（实测：只改
    // src/ 时 build.rs 不会重跑，时间戳不更新）。
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    emit_build_ident();

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR must be set by cargo");

    // 两个接口同属 android.app 包，一次生成避免重复 pub mod android::app。
    // 必须 async support（rsbinder 0.5.3 的 declare_binder_interface! 在 async
    // feature 下才生成 BnX::new_binder 同步服务；见 Cargo.toml 注释）。
    rsbinder_aidl::Builder::new()
        .include_dir(PathBuf::from("aidl"))
        .set_async_support(true)
        .source(PathBuf::from("aidl/android/app/IUidObserver.aidl"))
        .source(PathBuf::from("aidl/android/app/IActivityManager.aidl"))
        .output(PathBuf::from(&out_dir).join("fg_binder.rs"))
        .generate()
        .expect("failed to generate fg binder bindings");
}

/// 注入构建标识：短 git hash（工作区脏则加 `-dirty`）+ 构建时间（epoch 秒）。
fn emit_build_ident() {
    let hash =
        git_output(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let dirty = git_output(&["status", "--porcelain", "--untracked-files=no"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let ident = if dirty { format!("{hash}-dirty") } else { hash };
    println!("cargo:rustc-env=DF_GIT_HASH={ident}");

    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=DF_BUILD_EPOCH={epoch}");
    // banner 里要给人看，epoch 秒不可读，这里一并注入格式化后的 UTC 时间。
    println!("cargo:rustc-env=DF_BUILD_TIME={}", format_epoch_utc(epoch));
}

/// epoch 秒 → `YYYY-MM-DD HH:MM:SS UTC`。
///
/// 只用 std 做纯计算（不依赖 `date` 等外部命令，Windows 开发环境同样可用）。
/// 日期换算用 Howard Hinnant 的 civil_from_days 算法（days from 1970-01-01）。
fn format_epoch_utc(epoch: u64) -> String {
    let secs = epoch as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}

/// 1970-01-01 起的天数 → `(年, 月, 日)`。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    // 括号不可省：否则 `/` 与 `as` 会只作用在 else 分支上（类型也不匹配）。
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]

    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 跑 git 并取 stdout（trim 后）。git 不可用 / 非 git 源码树时返回 `None`。
fn git_output(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
