use std::path::PathBuf;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub script_path: String,
    pub source_line: String,
}

/// Install Vibe99 shell integration scripts to ~/.config/vibe99/.
/// Returns the script path and the line the user should add to their shell rc file.
#[tauri::command]
pub fn install_shell_integration() -> Result<InstallResult, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME environment variable not set".to_string())?;

    let config_dir = home.join(".config").join("vibe99");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("failed to create config dir: {e}"))?;

    let script_path = config_dir.join("shell-integration.zsh");
    std::fs::write(&script_path, ZSH_SCRIPT)
        .map_err(|e| format!("failed to write shell integration script: {e}"))?;

    let bash_path = config_dir.join("shell-integration.bash");
    std::fs::write(&bash_path, BASH_SCRIPT)
        .map_err(|e| format!("failed to write bash integration script: {e}"))?;

    let path_str = script_path.to_string_lossy().to_string();
    let source_line = format!(
        r#"[[ "$TERM_PROGRAM" == "vibe99" ]] && builtin source "{path_str}""#
    );

    Ok(InstallResult { script_path: path_str, source_line })
}

const ZSH_SCRIPT: &str = r#"# Vibe99 Shell Integration for zsh
# Enables command marks and exit code display in Vibe99.
#
# This file is managed by Vibe99 — do not edit manually.

_vibe99_command_ran=0

_vibe99_precmd() {
  local exit_code=$?
  if [[ $_vibe99_command_ran -eq 1 ]]; then
    printf "\e]133;D;%s\a" "$exit_code"
  fi
  _vibe99_command_ran=0
  printf "\e]133;A\a"
}

_vibe99_preexec() {
  _vibe99_command_ran=1
  printf "\e]133;C\a"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _vibe99_precmd
add-zsh-hook preexec _vibe99_preexec
"#;

const BASH_SCRIPT: &str = r#"# Vibe99 Shell Integration for bash
# Enables command marks and exit code display in Vibe99.
#
# This file is managed by Vibe99 — do not edit manually.

_vibe99_command_ran=0

_vibe99_precmd() {
  local exit_code=$?
  if [[ $_vibe99_command_ran -eq 1 ]]; then
    printf "\e]133;D;%s\a" "$exit_code"
  fi
  _vibe99_command_ran=0
  printf "\e]133;A\a"
}

_vibe99_preexec() {
  _vibe99_command_ran=1
  printf "\e]133;C\a"
}

if [[ -n "${preexec_functions+x}" ]]; then
  preexec_functions+=(_vibe99_preexec)
  precmd_functions+=(_vibe99_precmd)
else
  PROMPT_COMMAND="_vibe99_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zsh_script_registers_precmd_and_preexec_hooks() {
        assert!(ZSH_SCRIPT.contains("add-zsh-hook precmd _vibe99_precmd"));
        assert!(ZSH_SCRIPT.contains("add-zsh-hook preexec _vibe99_preexec"));
    }

    #[test]
    fn zsh_script_emits_osc133_prompt_start() {
        assert!(ZSH_SCRIPT.contains(r"\e]133;A\a"));
    }

    #[test]
    fn zsh_script_emits_osc133_command_start() {
        assert!(ZSH_SCRIPT.contains(r"\e]133;C\a"));
    }

    #[test]
    fn zsh_script_emits_osc133_command_end_with_exit_code() {
        assert!(ZSH_SCRIPT.contains(r"\e]133;D;%s\a"));
        assert!(ZSH_SCRIPT.contains("exit_code"));
    }

    #[test]
    fn zsh_script_tracks_command_ran_flag() {
        assert!(ZSH_SCRIPT.contains("_vibe99_command_ran=0"));
        assert!(ZSH_SCRIPT.contains("_vibe99_command_ran=1"));
    }

    #[test]
    fn bash_script_hooks_into_prompt_command() {
        assert!(BASH_SCRIPT.contains("PROMPT_COMMAND"));
        assert!(BASH_SCRIPT.contains("_vibe99_precmd"));
    }

    #[test]
    fn bash_script_supports_preexec_functions_array() {
        assert!(BASH_SCRIPT.contains("preexec_functions"));
        assert!(BASH_SCRIPT.contains("precmd_functions"));
    }

    #[test]
    fn bash_script_emits_osc133_markers() {
        assert!(BASH_SCRIPT.contains(r"\e]133;A\a"));
        assert!(BASH_SCRIPT.contains(r"\e]133;C\a"));
        assert!(BASH_SCRIPT.contains(r"\e]133;D;%s\a"));
    }

    #[test]
    fn bash_script_tracks_command_ran_flag() {
        assert!(BASH_SCRIPT.contains("_vibe99_command_ran=0"));
        assert!(BASH_SCRIPT.contains("_vibe99_command_ran=1"));
    }

    #[test]
    fn both_scripts_identify_as_vibe99_managed() {
        assert!(ZSH_SCRIPT.contains("Vibe99"));
        assert!(BASH_SCRIPT.contains("Vibe99"));
    }
}
