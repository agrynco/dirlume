use std::{ffi::OsString, fmt::Write as _};

use super::*;

pub(crate) const ENVIRONMENT: &[&str] = &[
    "PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
    "COMPOSE_FILE",
    "COMPOSE_PATH_SEPARATOR",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_PROFILES",
    "COMPOSE_ENV_FILES",
    "COMPOSE_DISABLE_ENV_FILE",
];

#[derive(PartialEq, Debug)]
enum Output {
    Completions,
    Containers,
    Services,
}

pub(super) struct Query {
    pub args: Vec<String>,
    output: Output,
}

const GLOBAL_VALUES: &[&str] = &[
    "--config",
    "--context",
    "-c",
    "--host",
    "-H",
    "--log-level",
    "-l",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
];
const COMPOSE_VALUES: &[&str] = &[
    "--ansi",
    "--env-file",
    "--file",
    "-f",
    "--parallel",
    "--profile",
    "--progress",
    "--project-directory",
    "--project-name",
    "-p",
];
const CONTAINER_SINGLE: &[&str] = &[
    "attach", "commit", "diff", "exec", "export", "logs", "port", "rename", "top",
];
const CONTAINER_MANY: &[&str] = &[
    "inspect", "kill", "pause", "restart", "rm", "start", "stats", "stop", "unpause", "update",
    "wait",
];
const COMPOSE_SINGLE: &[&str] = &["attach", "exec", "port", "run"];
const COMPOSE_MANY: &[&str] = &[
    "build", "config", "create", "down", "events", "images", "kill", "logs", "pause", "ps", "pull",
    "push", "restart", "rm", "start", "stats", "stop", "top", "unpause", "up", "volumes", "wait",
    "watch",
];

// A command segment ends at its first non-option argument. Only option values may consume it.
fn split_options<'a>(words: &'a [String], with_values: &[&str]) -> (&'a [String], &'a [String]) {
    let mut end = 0;
    while let Some(word) = words.get(end).filter(|word| word.starts_with('-')) {
        end += 1;
        if word == "--" {
            break;
        }
        if with_values.contains(&word.as_str()) {
            end += usize::from(end < words.len());
        }
    }
    words.split_at(end)
}

fn takes_value(argument: &str, verb: &str, compose: bool) -> bool {
    matches!(
        argument,
        "--tail"
            | "-n"
            | "--since"
            | "--until"
            | "--index"
            | "--format"
            | "--signal"
            | "--time"
            | "--timeout"
            | "--detach-keys"
            | "--env"
            | "-e"
            | "--env-file"
            | "--user"
            | "-u"
            | "--workdir"
            | "-w"
            | "--output"
            | "-o"
            | "--change"
            | "-c"
            | "--author"
            | "-a"
            | "--message"
            | "-m"
            | "--exit-code-from"
            | "--scale"
            | "--wait-timeout"
            | "--attach"
            | "--no-attach"
            | "--pull"
            | "--build-arg"
            | "--label"
            | "--entrypoint"
            | "--publish"
            | "-p"
            | "--volume"
            | "-v"
    ) || argument == "-t"
        && (matches!(verb, "restart" | "stop") || compose && matches!(verb, "up" | "down"))
}

fn expects_target(words: &[String], verb: &str, many: bool, compose: bool, prefix: &str) -> bool {
    let mut value = false;
    let mut options = true;
    let mut position = 0;
    for word in words {
        if value {
            value = false;
        } else if options && word == "--" {
            options = false;
        } else if options && word.starts_with('-') && word != "-" {
            value = takes_value(word, verb, compose);
        } else {
            position += 1;
        }
    }
    !value && (!options || !prefix.starts_with('-')) && (many || position == 0)
}

fn is_docker(program: &str, windows: bool) -> bool {
    if windows {
        program.eq_ignore_ascii_case("docker") || program.eq_ignore_ascii_case("docker.exe")
    } else {
        program == "docker"
    }
}

pub(super) fn query(context: &Context, windows: bool) -> Option<Query> {
    let (program, words) = context.words.split_first()?;
    if !is_docker(program, windows) {
        return None;
    }
    let (global, group) = split_options(words, GLOBAL_VALUES);
    match group {
        [container, verb, arguments @ ..]
            if container == "container"
                && (CONTAINER_SINGLE.contains(&verb.as_str())
                    || CONTAINER_MANY.contains(&verb.as_str()))
                && expects_target(
                    arguments,
                    verb,
                    CONTAINER_MANY.contains(&verb.as_str()),
                    false,
                    &context.prefix,
                ) =>
        {
            return Some(Query {
                args: global
                    .iter()
                    .cloned()
                    .chain(
                        [
                            "container",
                            "ls",
                            "--all",
                            "--no-trunc",
                            "--format",
                            r#"{"ID":{{json .ID}},"Names":{{json .Names}}}"#,
                        ]
                        .map(str::to_owned),
                    )
                    .collect(),
                output: Output::Containers,
            });
        }
        [compose, rest @ ..] if compose == "compose" => {
            let (project, subcommand) = split_options(rest, COMPOSE_VALUES);
            if let Some((verb, arguments)) = subcommand.split_first() {
                let many = COMPOSE_MANY.contains(&verb.as_str());
                if (many || COMPOSE_SINGLE.contains(&verb.as_str()))
                    && expects_target(arguments, verb, many, true, &context.prefix)
                {
                    return Some(Query {
                        args: global
                            .iter()
                            .cloned()
                            .chain(["compose".to_owned()])
                            .chain(project.iter().cloned())
                            .chain(["config".to_owned(), "--services".to_owned()])
                            .collect(),
                        output: Output::Services,
                    });
                }
            }
        }
        [] => {
            if words.is_empty()
                && !["container", "compose"]
                    .iter()
                    .any(|group| group.starts_with(&context.prefix))
                && !context.prefix.starts_with('-')
            {
                return None;
            }
        }
        [container, ..] if container == "container" => {}
        _ => return None,
    }
    Some(completion_query(words, &context.prefix))
}

fn completion_query(words: &[String], prefix: &str) -> Query {
    Query {
        args: ["__complete".to_owned()]
            .into_iter()
            .chain(words.iter().cloned())
            .chain([prefix.to_owned()])
            .collect(),
        output: Output::Completions,
    }
}

pub(super) fn extended_query(context: &Context, windows: bool) -> Option<Query> {
    query(context, windows).or_else(|| {
        let (program, words) = context.words.split_first()?;
        if !is_docker(program, windows) {
            return None;
        }
        Some(completion_query(words, &context.prefix))
    })
}

pub(super) fn flag_query(context: &Context) -> Option<Query> {
    let (_, words) = context.words.split_first()?;
    // Cobra can omit flags for an empty token and handles the dash probe in flag-value positions.
    (context.prefix.is_empty() && context.length == 0 && !words.iter().any(|word| word == "--"))
        .then(|| completion_query(words, "-"))
}

pub(super) fn add_flags(result: &mut CompletionBatch, flags: CompletionBatch) {
    // Keep both kinds of candidates visible even when the positional list fills the popup.
    let option_limit = (MAX_MATCHES - result.matches.len()).max(MAX_MATCHES / 2);
    let options: Vec<_> = flags
        .matches
        .into_iter()
        .filter(|option| {
            option.label.starts_with('-')
                && !matches!(option.label.as_str(), "-" | "--")
                && !result.matches.iter().any(|item| item.label == option.label)
        })
        .take(option_limit)
        .collect();
    result.matches.truncate(MAX_MATCHES - options.len());
    result.exclusive |= !options.is_empty();
    result.matches.extend(options);
}

#[derive(Deserialize)]
struct Container {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|letter| letter.is_ascii_alphanumeric() || b"_.-".contains(&letter))
}

pub(super) fn batch(
    query: &Query,
    context: &Context,
    line: &str,
    output: &[u8],
    windows: bool,
) -> CompletionBatch {
    let mut names = BTreeSet::new();
    let text = std::str::from_utf8(output).unwrap_or_default();
    let mut exclusive = true;
    match query.output {
        Output::Containers => {
            for row in text
                .lines()
                .filter_map(|row| serde_json::from_str::<Container>(row).ok())
            {
                if (!context.prefix.is_empty() || row.names.is_empty())
                    && !row.id.is_empty()
                    && row.id.bytes().all(|letter| letter.is_ascii_hexdigit())
                {
                    names.insert(row.id);
                }
                names.extend(
                    row.names
                        .split(',')
                        .map(str::trim)
                        .filter(|name| valid_name(name))
                        .map(str::to_owned),
                );
            }
        }
        Output::Services => names.extend(
            text.lines()
                .filter(|name| valid_name(name))
                .map(str::to_owned),
        ),
        Output::Completions => {
            // A Cobra directive separates completion results from diagnostics and requests for file completion.
            let directive = text
                .lines()
                .next_back()
                .and_then(|line| line.strip_prefix(':'))
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|directive| directive & 1 == 0);
            exclusive = directive.is_some_and(|directive| directive & 4 != 0);
            if directive.is_some_and(|directive| directive & (8 | 16) == 0) {
                names.extend(
                    text.lines()
                        .map(|row| row.split('\t').next().unwrap_or_default())
                        .filter(|candidate| valid_name(candidate))
                        .map(str::to_owned),
                );
            }
        }
    }
    let original = byte_at_utf16(line, context.index)
        .zip(byte_at_utf16(line, context.index + context.length))
        .map(|(start, end)| &line[start..end])
        .unwrap_or_default();
    let quotation = original
        .chars()
        .next()
        .filter(|first| matches!(first, '\'' | '"'));
    let matches: Vec<_> = names
        .into_iter()
        .filter(|label| {
            if windows {
                label
                    .to_ascii_lowercase()
                    .starts_with(&context.prefix.to_ascii_lowercase())
            } else {
                label.starts_with(&context.prefix)
            }
        })
        .take(MAX_MATCHES)
        .map(|label| {
            let text =
                quotation.map_or_else(|| label.clone(), |quote| format!("{quote}{label}{quote}"));
            Suggestion {
                label,
                text,
                directory: false,
            }
        })
        .collect();
    CompletionBatch {
        index: context.index,
        length: context.length,
        exclusive: exclusive || !matches.is_empty(),
        matches,
    }
}

fn local_output(request: &CompletionRequest, query: &Query, cwd: &Path) -> Option<Vec<u8>> {
    #[cfg(windows)]
    let mut environment =
        crate::windows_environment::variables(request.refresh_environment).ok()?;
    #[cfg(not(windows))]
    let mut environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let same_name = |left: &str, right: &str| {
        if cfg!(windows) {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };
    if let Some(shell) = &request.shell_environment {
        for name in ENVIRONMENT {
            if let Some(value) = shell.get(*name) {
                environment.retain(|(key, _)| !same_name(&key.to_string_lossy(), name));
                if let Some(value) = value
                    .as_ref()
                    .filter(|value| value.len() <= 16_384 && !value.contains('\0'))
                {
                    environment.push((OsString::from(name), value.into()));
                }
            }
        }
    }
    let path = environment
        .iter()
        .find(|(key, _)| same_name(&key.to_string_lossy(), "PATH"))?;
    let executable_name = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    let program = std::env::split_paths(&path.1)
        .filter(|path| path.is_absolute())
        .map(|path| path.join(executable_name))
        .find(|path| executable(path))?;
    let mut command = Command::new(program);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .args(&query.args);
    read_process_with_timeout(command, Vec::new(), Duration::from_millis(1600))
}

pub(super) fn local(
    request: &CompletionRequest,
    context: &Context,
    cwd: &Path,
) -> Option<CompletionBatch> {
    let legacy = query(context, cfg!(windows));
    let extended = legacy.is_none();
    let query = legacy.or_else(|| {
        cfg!(any(windows, target_os = "linux"))
            .then(|| extended_query(context, cfg!(windows)))
            .flatten()
    })?;
    let output = local_output(request, &query, cwd).unwrap_or_default();
    let mut result = batch(&query, context, &request.line, &output, cfg!(windows));
    if let Some((flags, output)) = cfg!(any(windows, target_os = "linux"))
        .then(|| flag_query(context))
        .flatten()
        .and_then(|flags| local_output(request, &flags, cwd).map(|output| (flags, output)))
    {
        add_flags(
            &mut result,
            batch(&flags, context, &request.line, &output, cfg!(windows)),
        );
    }
    (!extended || result.exclusive || !result.matches.is_empty()).then_some(result)
}

pub(super) fn remote_script(
    environment: Option<&HashMap<String, Option<String>>>,
    query: &Query,
) -> String {
    let mut script = String::new();
    if let Some(environment) = environment {
        for name in ENVIRONMENT.iter().copied().filter(|name| *name != "PATH") {
            if let Some(value) = environment.get(name) {
                if let Some(value) = value
                    .as_ref()
                    .filter(|value| value.len() <= 16_384 && !value.contains('\0'))
                {
                    let _ = writeln!(&mut script, "export {name}={}", crate::ssh::quote(value));
                } else {
                    let _ = writeln!(&mut script, "unset {name}");
                }
            }
        }
    }
    let args = query
        .args
        .iter()
        .map(|arg| crate::ssh::quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{script}exec docker {args} </dev/null 2>/dev/null")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(line: &str) -> (Query, Context) {
        let context = shell_context(line, line.encode_utf16().count(), false).unwrap();
        let query = query(&context, false).unwrap();
        (query, context)
    }

    #[test]
    fn uses_cli_completion_for_subcommands_flags_and_flag_values() {
        for draft in [
            "docker co",
            "docker compose lo",
            "docker container logs --ta",
            "docker compose logs -",
            "docker container logs --tail 2",
        ] {
            let (query, context) = plan(draft);
            assert_eq!(query.output, Output::Completions, "{draft}");
            assert_eq!(query.args.first().unwrap(), "__complete");
            assert_eq!(query.args.last().unwrap(), &context.prefix);
        }
        let draft = "docker compose logs -";
        let (query, context) = plan(draft);
        let flags = batch(
            &query,
            &context,
            draft,
            b"--follow\tFollow logs\n-f\tFollow logs\n:4\n",
            false,
        );
        assert_eq!(
            flags
                .matches
                .into_iter()
                .map(|item| item.label)
                .collect::<Vec<_>>(),
            ["--follow", "-f"]
        );
        assert!(batch(&query, &context, draft, b"--follow\n:1\n", false)
            .matches
            .is_empty());
        assert!(batch(&query, &context, draft, b"", false)
            .matches
            .is_empty());
    }

    #[test]
    fn completes_docker_commands_outside_the_container_and_compose_groups() {
        for (line, windows) in [
            ("docker image ls --for", false),
            ("DOCKER.EXE image ls --for", true),
        ] {
            let context = shell_context(line, line.len(), windows).unwrap();
            let plan = extended_query(&context, windows).unwrap();
            assert_eq!(plan.args, ["__complete", "image", "ls", "--for"]);
            assert_eq!(
                batch(
                    &plan,
                    &context,
                    line,
                    b"--format\tOutput format\n:4\n",
                    windows
                )
                .matches[0]
                    .label,
                "--format"
            );
        }
    }

    #[test]
    fn keeps_a_successful_empty_response_that_disallows_files() {
        let line = "docker ps ";
        let context = shell_context(line, line.len(), false).unwrap();
        let query = extended_query(&context, false).unwrap();
        let result = batch(&query, &context, line, b":4\n", false);
        assert!(result.matches.is_empty());
        assert!(result.exclusive);
        for output in [b":0\n".as_slice(), b":1\n", b""] {
            assert!(!batch(&query, &context, line, output, false).exclusive);
        }
    }

    #[test]
    fn adds_options_to_empty_tokens_without_displacing_positional_candidates() {
        for (line, primary_output, options, expected) in [
            (
                "docker ps ",
                b":4\n".as_slice(),
                b"--all\n--format\n:4\n".as_slice(),
                vec!["--all", "--format"],
            ),
            (
                "docker image ",
                b"ls\n:4\n",
                b"--help\n:4\n",
                vec!["ls", "--help"],
            ),
            (
                "docker image ls ",
                b":4\n",
                b"--format\n:4\n",
                vec!["--format"],
            ),
            (
                "docker container logs ",
                br#"{"ID":"aabb","Names":"web-api"}"#,
                b"--follow\n:4\n",
                vec!["web-api", "--follow"],
            ),
            (
                "docker compose up ",
                b"worker\n",
                b"--build\n:4\n",
                vec!["worker", "--build"],
            ),
            ("docker ps --format ", b":4\n", b":0\n", vec![]),
            ("docker ps --format ", b"json\n:4\n", b":0\n", vec!["json"]),
        ] {
            let context = shell_context(line, line.len(), false).unwrap();
            let primary = extended_query(&context, false).unwrap();
            let flags = flag_query(&context).unwrap();
            assert_eq!(flags.args.last().unwrap(), "-");
            let mut result = batch(&primary, &context, line, primary_output, false);
            add_flags(&mut result, batch(&flags, &context, line, options, false));
            assert_eq!(result.index, line.len(), "{line}");
            assert_eq!(result.length, 0, "{line}");
            assert_eq!(
                result
                    .matches
                    .iter()
                    .map(|item| item.label.as_str())
                    .collect::<Vec<_>>(),
                expected,
                "{line}"
            );
        }
        for line in ["docker ps --fo", "docker ps -- "] {
            let context = shell_context(line, line.len(), false).unwrap();
            assert!(flag_query(&context).is_none(), "{line}");
        }
        let line = "docker compose up ";
        let (primary, context) = plan(line);
        let services = (0..MAX_MATCHES)
            .map(|index| format!("service-{index}\n"))
            .collect::<String>();
        let mut result = batch(&primary, &context, line, services.as_bytes(), false);
        let flags = flag_query(&context).unwrap();
        add_flags(
            &mut result,
            batch(&flags, &context, line, b"--build\n:4\n", false),
        );
        assert_eq!(result.matches.len(), MAX_MATCHES);
        assert_eq!(result.matches.first().unwrap().label, "service-0");
        assert_eq!(result.matches.last().unwrap().label, "--build");
    }

    #[test]
    fn looks_up_full_ids_and_uses_the_requested_docker_context() {
        let draft = "docker --context second container logs --tail 20 we";
        let (query, context) = plan(draft);
        assert_eq!(query.output, Output::Containers);
        assert_eq!(&query.args[..4], ["--context", "second", "container", "ls"]);
        let output = br#"{"ID":"aabbccdd","Names":"web-api"}"#;
        assert_eq!(
            batch(&query, &context, draft, output, false).matches[0].label,
            "web-api"
        );
        let draft = "docker container inspect aabb";
        let (query, context) = plan(draft);
        assert_eq!(
            batch(&query, &context, draft, output, false).matches[0].label,
            "aabbccdd"
        );
    }

    #[test]
    fn passes_compose_project_selection_and_keeps_surrounding_tokens_and_quotes() {
        let draft = r#"docker compose -f 'alternate project.yaml' logs --tail 20 "we" --follow"#;
        let caret = draft.find(" --follow").unwrap();
        let context = shell_context(draft, caret, false).unwrap();
        let query = query(&context, false).unwrap();
        assert_eq!(query.output, Output::Services);
        assert_eq!(
            query.args,
            [
                "compose",
                "-f",
                "alternate project.yaml",
                "config",
                "--services"
            ]
        );
        let result = batch(&query, &context, draft, b"web\nworker\n", false);
        assert_eq!(result.matches[0].text, "\"web\"");
        assert_eq!(
            &draft[..result.index],
            "docker compose -f 'alternate project.yaml' logs --tail 20 "
        );
        assert_eq!(&draft[result.index + result.length..], " --follow");
        assert!(batch(&query, &context, draft, b"", false)
            .matches
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn looks_up_services_in_each_shells_project_and_environment() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin with spaces");
        let local_project = temp.path().join("local");
        let remote_project = temp.path().join("remote");
        for folder in [&bin, &local_project, &remote_project] {
            fs::create_dir(folder).unwrap();
        }
        let program = bin.join("docker");
        fs::write(
            &program,
            r#"#!/bin/sh
[ "$*" = 'compose config --services' ] || exit 2
exec /bin/cat -- "${COMPOSE_FILE:-compose.yaml}"
"#,
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(local_project.join("compose.yaml"), "web-local\n").unwrap();
        fs::write(remote_project.join("selected.yaml"), "web-remote\n").unwrap();
        let line = "docker compose logs --tail 20 web";
        let (query, context) = plan(line);
        let mut environment = HashMap::from([
            ("PATH".to_owned(), Some(bin.to_string_lossy().into_owned())),
            ("COMPOSE_FILE".to_owned(), None),
        ]);
        let request = CompletionRequest {
            line: line.to_owned(),
            caret: line.len(),
            directory: local_project.to_string_lossy().into_owned(),
            refresh_environment: false,
            shell_environment: Some(environment.clone()),
        };
        assert_eq!(
            local(&request, &context, &local_project).unwrap().matches[0].label,
            "web-local"
        );
        environment.insert("COMPOSE_FILE".to_owned(), Some("selected.yaml".to_owned()));
        let remote = RemoteCompletionRequest {
            line: line.to_owned(),
            caret: line.len(),
            directory: remote_project.to_string_lossy().into_owned(),
            search_path: Some(bin.to_string_lossy().into_owned()),
            shell_environment: Some(environment),
        };
        let script = super::super::remote_command(
            &remote,
            &remote_script(remote.shell_environment.as_ref(), &query),
            false,
        );
        let output = Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            batch(
                &query,
                &context,
                line,
                super::super::remote_output(&output.stdout),
                false
            )
            .matches[0]
                .label,
            "web-remote"
        );
    }
}
