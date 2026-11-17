use keyring::Entry;

pub fn read_secret(account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new("ZeroKey", account).map_err(|_| "无法访问系统凭据库。")?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统凭据库，请在正常桌面会话中打开应用。".into()),
    }
}

pub fn write_secret(account: &str, secret: &str) -> Result<(), String> {
    Entry::new("ZeroKey", account)
        .and_then(|entry| entry.set_password(secret))
        .map_err(|_| "无法保存到系统凭据库。".into())
}

pub fn delete_secret(account: &str) -> Result<(), String> {
    let entry = Entry::new("ZeroKey", account).map_err(|_| "无法访问系统凭据库。")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法移除系统凭据。".into()),
    }
}

pub fn credential_store_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows 凭据管理器"
    } else if cfg!(target_os = "macos") {
        "macOS 钥匙串"
    } else {
        "系统 Secret Service"
    }
}

#[cfg(target_os = "windows")]
fn wait_operation<T: windows::core::RuntimeType + 'static>(
    operation: windows::Foundation::IAsyncOperation<T>,
    seconds: u64,
) -> Result<T, String> {
    use windows::Foundation::AsyncStatus;
    let start = std::time::Instant::now();
    loop {
        match operation
            .Status()
            .map_err(|_| "无法读取 Windows Hello 状态。")?
        {
            AsyncStatus::Completed => {
                return operation
                    .GetResults()
                    .map_err(|_| "Windows Hello 未能完成，请重试。".into())
            }
            AsyncStatus::Canceled => return Err("Windows Hello 已取消；未签发凭证。".into()),
            AsyncStatus::Error => return Err("Windows Hello 无法完成验证，请重试。".into()),
            _ => {}
        }
        if start.elapsed() >= std::time::Duration::from_secs(seconds) {
            let _ = operation.Cancel();
            return Err("Windows Hello 等待超时；未签发凭证，请重新确认授权。".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(target_os = "windows")]
pub fn hello_available() -> bool {
    use windows::{
        Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability},
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };
    unsafe {
        let initialized = RoInitialize(RO_INIT_MULTITHREADED).is_ok();
        let available = UserConsentVerifier::CheckAvailabilityAsync()
            .ok()
            .and_then(|operation| wait_operation(operation, 5).ok())
            .map(|state| state == UserConsentVerifierAvailability::Available)
            .unwrap_or(false);
        if initialized {
            RoUninitialize();
        }
        available
    }
}

#[cfg(not(target_os = "windows"))]
pub fn hello_available() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn verify_native(message: &str, owner: isize) -> Result<(), String> {
    use windows::{
        core::{factory, HSTRING},
        Foundation::IAsyncOperation,
        Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
        Win32::{
            Foundation::HWND,
            System::WinRT::{
                IUserConsentVerifierInterop, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
            },
        },
    };
    if owner == 0 {
        return Err("无法确定授权窗口，请重新打开 ZeroKey。".into());
    }
    unsafe {
        let initialized = RoInitialize(RO_INIT_MULTITHREADED).is_ok();
        let result = (|| {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|_| "无法启动 Windows Hello。")?;
            let operation: IAsyncOperation<UserConsentVerificationResult> = interop
                .RequestVerificationForWindowAsync(HWND(owner as *mut _), &HSTRING::from(message))
                .map_err(|_| "Windows Hello 无法附加到 ZeroKey 窗口，请重试。")?;
            match wait_operation(operation, 90)? {
                UserConsentVerificationResult::Verified => Ok(()),
                _ => Err("Windows Hello 已取消或未通过；未签发凭证。".into()),
            }
        })();
        if initialized {
            RoUninitialize();
        }
        result
    }
}

#[cfg(not(target_os = "windows"))]
pub fn verify_native(_: &str, _: isize) -> Result<(), String> {
    Err("此平台尚未接入系统生物识别，请先在设置中配置 ZeroKey 授权 PIN。".into())
}
