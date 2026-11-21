//! Child console policy is separate from credentials and never changes standard handles.
use serde_json::Value;
use std::process::Command;

pub fn no_window(body: &Value) -> Result<bool, String> {
    match body.get("noWindow") {
        None => Ok(false), // Preserve legacy behavior for direct native callers.
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err("INVALID_INPUT: noWindow 必须为 true 或 false。".into()),
    }
}

pub fn configure(command: &mut Command, no_window: bool) {
    #[cfg(windows)]
    if no_window {
        use std::os::windows::process::CommandExt;
        // SW_HIDE only hides a window after allocation. CREATE_NO_WINDOW prevents allocation.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = (command, no_window);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_console_policy_preserves_legacy_calls_and_validates_explicit_modes() {
        assert!(!no_window(&json!({})).unwrap());
        assert!(!no_window(&json!({"noWindow":false})).unwrap());
        assert!(no_window(&json!({"noWindow":true})).unwrap());
        for value in [json!("false"), json!(null), json!(1)] {
            assert!(no_window(&json!({"noWindow":value})).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn parallel_windowless_children_keep_input_output_errors_and_exit_codes() {
        use std::io::Write;
        use std::process::Stdio;
        let mut children = Vec::new();
        for index in 0..3 {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--ignored",
                    "--exact",
                    "launcher::tests::console_probe",
                    "--nocapture",
                ])
                .env("ZEROKEY_TEST_CONSOLE_PROBE", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            configure(&mut command, true);
            let mut child = command.spawn().unwrap();
            writeln!(child.stdin.take().unwrap(), "input-{index}").unwrap();
            children.push((index, child));
        }
        for (index, child) in children {
            let output = child.wait_with_output().unwrap();
            assert_eq!(output.status.code(), Some(23));
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("console-window=0"), "{stdout}");
            assert!(
                stdout.contains(&format!("stdout:input-{index}")),
                "{stdout}"
            );
            assert!(String::from_utf8(output.stderr)
                .unwrap()
                .contains("stderr-marker"));
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture; invoked by the parallel launch regression"]
    fn console_probe() {
        use std::io::{Read, Write};
        use windows::Win32::System::Console::GetConsoleWindow;
        assert_eq!(
            std::env::var("ZEROKEY_TEST_CONSOLE_PROBE").as_deref(),
            Ok("1")
        );
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        println!(
            "console-window={}",
            unsafe { GetConsoleWindow() }.0 as usize
        );
        println!("stdout:{}", input.trim());
        eprintln!("stderr-marker");
        std::io::stdout().flush().unwrap();
        std::io::stderr().flush().unwrap();
        std::process::exit(23);
    }
}
