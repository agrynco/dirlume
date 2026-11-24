COMP_POINT=$1
COMP_LINE=$2
shift 2
COMP_WORDS=("$@")
COMP_CWORD=$((${#COMP_WORDS[@]} - 1))
COMP_TYPE=9
COMP_KEY=9
current=${COMP_WORDS[COMP_CWORD]}

if (( COMP_CWORD == 0 )); then
    while IFS= read -r choice; do printf '%s\0' "$choice"; done < <(compgen -c -- "$current" | head -n 80)
    exit
fi

for source_file in /usr/share/bash-completion/bash_completion /etc/bash_completion \
    /opt/homebrew/etc/profile.d/bash_completion.sh /usr/local/etc/profile.d/bash_completion.sh; do
    if [[ -r $source_file ]]; then
        source "$source_file" >/dev/null 2>&1
        break
    fi
done
if [[ -r ${HOME:-}/.bash_completion ]]; then
    source "$HOME/.bash_completion" >/dev/null 2>&1
fi

program=${COMP_WORDS[0]}
previous=${COMP_WORDS[COMP_CWORD-1]}
spec=$(complete -p -- "$program" 2>/dev/null)
if [[ -z $spec ]]; then
    # Load a command's rules without installing bash-completion's blanket
    # filename fallback for commands that have no rules of their own.
    if declare -F _comp_load >/dev/null; then
        _comp_load -- "$program" >/dev/null 2>&1
    elif declare -F __load_completion >/dev/null; then
        __load_completion "$program" >/dev/null 2>&1
    fi
    spec=$(complete -p -- "$program" 2>/dev/null)
fi
COMPREPLY=()
if [[ $spec =~ [[:space:]]-F[[:space:]]([[:alnum:]_][[:alnum:]_.:-]*) ]]; then
    function_name=${BASH_REMATCH[1]}
    if declare -F "$function_name" >/dev/null; then
        dirlume_filenames=false
        if [[ ${DIRLUME_REMOTE_BASH_COMPLETION:-} == 1 ]]; then
            [[ $spec == *' -o filenames '* ]] && dirlume_filenames=true
            # The completion function runs without Readline's active compspec.
            compopt() {
                local filenames=$dirlume_filenames
                local -a args=("$@")
                while (( $# >= 2 )); do
                    case $1 in -o|+o) ;; *) break ;; esac
                    if [[ $2 == filenames ]]; then
                        if [[ $1 == -o ]]; then filenames=true; else filenames=false; fi
                    fi
                    shift 2
                done
                if (( $# )); then
                    builtin compopt "${args[@]}"
                else
                    dirlume_filenames=$filenames
                fi
            }
        fi
        "$function_name" "$program" "$current" "$previous" >/dev/null 2>&1
        for choice in "${COMPREPLY[@]:0:80}"; do
            if $dirlume_filenames && [[ -n $choice ]]; then
                path=$choice
                if [[ $path == '~/'* ]]; then path=$HOME/${path#\~/}; fi
                if [[ -d $path ]]; then choice="${choice%/}/"; fi
            fi
            printf '%s\0' "$choice"
        done
    fi
fi

if [[ $spec == *' -o plusdirs '* ]] ||
    { (( ${#COMPREPLY[@]} == 0 )) && [[ $spec == *' -o dirnames '* ]]; }; then
    while IFS= read -r choice; do printf '%s/\0' "${choice%/}"; done < <(compgen -d -- "$current" | head -n 80)
elif (( ${#COMPREPLY[@]} == 0 )) && [[ $spec == *' -o default '* ]]; then
    while IFS= read -r choice; do
        [[ -d $choice ]] && choice="${choice%/}/"
        printf '%s\0' "$choice"
    done < <(compgen -f -- "$current" | head -n 80)
fi
