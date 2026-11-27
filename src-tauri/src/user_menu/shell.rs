use std::{collections::HashMap, path::Path};

use portable_pty::CommandBuilder;
use serde::Deserialize;

use super::{directory, Entry, SourceVersion, Visibility};
use crate::{local, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub(super) source: SourceVersion,
    index: Vec<usize>,
    opposite: Option<String>,
    focused: Option<String>,
    marked: Vec<String>,
    inputs: HashMap<String, String>,
}

fn entry_at<'a>(entries: &'a [Entry], index: &[usize]) -> Option<&'a Entry> {
    let (first, rest) = index.split_first()?;
    let entry = entries.get(*first)?;
    match (entry, rest) {
        (_, []) => Some(entry),
        (Entry::Submenu { children, .. }, rest) => entry_at(children, rest),
        _ => None,
    }
}

pub(super) fn name_matches(mask: &str, name: &str) -> bool {
    if mask.is_empty() {
        return true;
    }
    let pattern: Vec<char> = if cfg!(windows) {
        mask.to_lowercase()
    } else {
        mask.to_owned()
    }
    .chars()
    .collect();
    let name: Vec<char> = if cfg!(windows) {
        name.to_lowercase()
    } else {
        name.to_owned()
    }
    .chars()
    .collect();
    let (mut at, mut token, mut star, mut suffix) = (0, 0, None, 0);
    while at < name.len() {
        match pattern.get(token) {
            Some('*') => {
                star = Some(token);
                token += 1;
                suffix = at;
            }
            Some(&c) if c == '?' || c == name[at] => {
                token += 1;
                at += 1;
            }
            _ => {
                let Some(star) = star else {
                    return false;
                };
                token = star + 1;
                suffix += 1;
                at = suffix;
            }
        }
    }
    pattern[token..].iter().all(|&c| c == '*')
}

fn checked_item(path: &str, folder: &Path) -> Result<(String, bool)> {
    let item = local::absolute(path).map_err(crate::message)?;
    let parent = item
        .parent()
        .ok_or("The selected item has no parent folder.")?;
    let parent = directory(&local::display_path(parent).map_err(crate::message)?)?;
    if !parent.starts_with(folder) {
        return Err("The selected item is outside the working folder.".into());
    }
    let metadata = item.metadata().map_err(crate::message)?;
    Ok((
        local::display_path(item).map_err(crate::message)?,
        metadata.is_dir(),
    ))
}

struct Template<'a> {
    command: &'a mut CommandBuilder,
    values: HashMap<&'a str, Vec<String>>,
    prefix: String,
    count: usize,
}

impl Template<'_> {
    fn apply(&mut self, text: &str) -> Result<String> {
        let mut rest = text;
        let mut expanded = String::new();
        while let Some((before, after)) = rest.split_once("{{") {
            expanded.push_str(before);
            let (name, tail) = after
                .split_once("}}")
                .ok_or("Close the User Menu token with }}.")?;
            let name = name.trim();
            let values = self
                .values
                .get(name)
                .filter(|values| !values.is_empty())
                .ok_or_else(|| format!("No value is available for token {{{{{name}}}}}."))?;
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    expanded.push(' ');
                }
                if value.contains('\0') {
                    return Err("A token contains a null character.".into());
                }
                let variable = format!("{}_ARG_{}", self.prefix, self.count);
                self.count += 1;
                self.command.env(&variable, value);
                if cfg!(windows) {
                    expanded.push_str(&format!("([string]$env:{variable})"));
                } else {
                    expanded.push_str(&format!("\"${{{variable}}}\""));
                }
            }
            rest = tail;
        }
        expanded.push_str(rest);
        Ok(expanded)
    }
}

pub(super) fn prepare(
    request: Run,
    entries: &[Entry],
    folder: &Path,
    refresh_environment: bool,
) -> Result<(CommandBuilder, String)> {
    let Some(Entry::Command {
        label,
        visibility,
        mask,
        steps,
        prompts,
        ..
    }) = entry_at(entries, &request.index)
    else {
        return Err("The selected User Menu command is unavailable.".into());
    };
    let focused = request
        .focused
        .as_deref()
        .map(|path| checked_item(path, folder))
        .transpose()?;
    let marked: Vec<String> = request
        .marked
        .iter()
        .map(|path| checked_item(path, folder).map(|(path, _)| path))
        .collect::<Result<_>>()?;
    let visible = match visibility {
        Visibility::Always => true,
        Visibility::Selection => !marked.is_empty(),
        Visibility::File | Visibility::Folder => focused.as_ref().is_some_and(|(path, folder)| {
            *folder == matches!(visibility, Visibility::Folder)
                && Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name_matches(mask, name))
        }),
    };
    if !visible {
        return Err("The command does not apply to the captured pane selection.".into());
    }

    let mut values = HashMap::new();
    values.insert(
        "activeFolder",
        vec![local::display_path(folder).map_err(crate::message)?],
    );
    if let Some(opposite) = &request.opposite {
        if let Ok(path) = directory(opposite) {
            values.insert(
                "oppositeFolder",
                vec![local::display_path(&path).map_err(crate::message)?],
            );
        }
    }
    if let Some((path, _)) = &focused {
        let file = Path::new(path);
        for (key, part) in [
            ("focusedName", file.file_name()),
            ("focusedStem", file.file_stem()),
            ("focusedExtension", file.extension()),
        ] {
            values.insert(
                key,
                vec![part
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_owned()],
            );
        }
        values.insert("focusedPath", vec![path.clone()]);
    }
    values.insert("markedPaths", marked);
    let prompt_tokens: Vec<String> = prompts
        .iter()
        .map(|prompt| format!("prompt:{}", prompt.name))
        .collect();
    for (prompt, key) in prompts.iter().zip(&prompt_tokens) {
        let value = request
            .inputs
            .get(&prompt.name)
            .ok_or_else(|| format!("Enter a value for {}.", prompt.label))?;
        values.insert(key, vec![value.clone()]);
    }

    #[cfg(windows)]
    let shell = {
        let root = std::env::var_os("SystemRoot")
            .ok_or("The Windows PowerShell location is unavailable.")?;
        let path =
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        if !path.is_absolute() || !path.is_file() {
            return Err("The Windows PowerShell location is unavailable.".into());
        }
        path
    };
    #[cfg(unix)]
    let shell = crate::terminal::shell_program();
    #[cfg(unix)]
    if !matches!(
        Path::new(&shell).file_name().and_then(|name| name.to_str()),
        Some("bash" | "sh" | "dash" | "zsh")
    ) {
        return Err("User Menu commands support sh, dash, bash, or zsh on this platform.".into());
    }
    let mut command = CommandBuilder::new(shell);
    command.cwd(folder);
    command.env("TERM", "xterm-256color");
    #[cfg(windows)]
    crate::windows_environment::apply(&mut command, refresh_environment).map_err(crate::message)?;
    #[cfg(unix)]
    let _ = refresh_environment;

    let run = format!("DIRLUME_{}", uuid::Uuid::new_v4().simple());
    let working_folder = format!("{run}_FOLDER");
    command.env(
        &working_folder,
        local::display_path(folder).map_err(crate::message)?,
    );
    let mut template = Template {
        command: &mut command,
        values,
        prefix: run.clone(),
        count: 0,
    };
    #[cfg(unix)]
    let mut script = format!("trap 'exit 130' INT TERM\ncd -- \"${working_folder}\" || exit 1\n");
    #[cfg(windows)]
    let mut script = format!("$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\nSet-Location -LiteralPath $env:{working_folder}\n");
    for (index, step) in steps.iter().enumerate() {
        use std::fmt::Write;
        let number = index + 1;
        let var = format!("{run}_STEP_{number}");
        let expanded = template.apply(step)?;
        template.command.env(&var, expanded);
        #[cfg(unix)]
        writeln!(script, "printf '\\n[Step {number}]\\n'; eval \"${var}\"\n{run}=$?\nif [ \"${run}\" -ne 0 ]; then printf '[Step {number} failed with exit code %s]\\n' \"${run}\" >&2; exit \"${run}\"; fi").expect("write to String");
        #[cfg(windows)]
        writeln!(script, "Write-Host \"`n[Step {number}]\"\n$global:LASTEXITCODE = 0\ntry {{\n. ([ScriptBlock]::Create($env:{var}))\nif (!$? -or $global:LASTEXITCODE -ne 0) {{ throw \"Exit code $global:LASTEXITCODE\" }}\n}} catch {{ Write-Host \"[Step {number} failed] $_\"; if ($global:LASTEXITCODE -ne 0) {{ exit $global:LASTEXITCODE }}; exit 1 }}").expect("write to String");
    }
    #[cfg(windows)]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        command.args([
            "-NoProfile",
            "-NoLogo",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ]);
    }
    #[cfg(unix)]
    command.args(["-c", script.as_str()]);
    Ok((command, label.clone()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::user_menu::{revision, Document, Prompt, UserMenus, LOCAL_NAME, PERSONAL_NAME};

    #[test]
    fn only_the_reviewed_command_runs_with_literal_arguments_and_stops_on_failure() {
        let fixture = tempfile::tempdir().unwrap();
        let folder = fixture.path().canonicalize().unwrap();
        let opposite = folder.join("інші & файли");
        fs::create_dir(&opposite).unwrap();
        let first = folder.join("file one 'é & $.txt");
        let second = folder.join("file two (`sample) ;.txt");
        fs::write(&first, []).unwrap();
        fs::write(&second, []).unwrap();

        #[cfg(windows)]
        let steps = ["function Store { Set-Content -LiteralPath .\\args.txt -Encoding UTF8 -Value ([string[]]$args) }; Store {{focusedPath}} {{oppositeFolder}} {{markedPaths}} {{prompt:value}}",
            "cmd.exe /d /c exit 7", "Set-Content -LiteralPath .\\unexpected.txt -Value unexpected"];
        #[cfg(unix)]
        let steps = ["printf '%s\\n' {{focusedPath}} {{oppositeFolder}} {{markedPaths}} {{prompt:value}} > args.txt",
            "(exit 7)", "touch unexpected.txt"];
        let doc = Document {
            version: 1,
            entries: vec![Entry::Command {
                label: "Example".into(),
                hotkey: "F4".into(),
                visibility: Visibility::File,
                mask: "*.txt".into(),
                steps: steps.into_iter().map(str::to_owned).collect(),
                prompts: vec![Prompt {
                    name: "value".into(),
                    label: "Value".into(),
                    initial: String::new(),
                }],
            }],
        };
        let local_file = folder.join(LOCAL_NAME);
        let personal = folder.join(PERSONAL_NAME);
        let bytes = serde_json::to_vec(&doc).unwrap();
        fs::write(&local_file, &bytes).unwrap();
        let wire_path = |path: &Path| local::display_path(path).unwrap();
        let prompt = "literal ' \" $ && ` & $(bad)";
        let request = || Run {
            source: SourceVersion {
                folder: wire_path(&folder),
                path: wire_path(&local_file),
                revision: Some(revision(&bytes)),
            },
            index: vec![0],
            opposite: Some(wire_path(&opposite)),
            focused: Some(wire_path(&first)),
            marked: vec![wire_path(&first), wire_path(&second)],
            inputs: HashMap::from([("value".into(), prompt.into())]),
        };
        let menus = UserMenus::default();
        assert!(menus.prepare(request(), &personal, false).is_err());
        menus
            .0
            .lock()
            .unwrap()
            .insert(local_file.clone(), revision(&bytes));
        fs::write(&local_file, b"changed").unwrap();
        assert!(menus.prepare(request(), &personal, false).is_err());
        fs::write(&local_file, &bytes).unwrap();
        let (command, _) = menus.prepare(request(), &personal, false).unwrap();
        let (code, transcript) = crate::terminal::run_menu_fixture(command);
        assert_eq!(code, 7, "{transcript}");
        assert!(transcript.contains("Step 2"), "{transcript}");
        let output = fs::read_to_string(folder.join("args.txt")).unwrap();
        assert_eq!(
            output
                .trim_start_matches('\u{feff}')
                .lines()
                .collect::<Vec<_>>(),
            [
                wire_path(&first),
                wire_path(&opposite),
                wire_path(&first),
                wire_path(&second),
                prompt.to_owned()
            ]
        );
        assert!(!folder.join("unexpected.txt").exists());
    }
}
