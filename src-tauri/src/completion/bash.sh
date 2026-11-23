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
if [[ -z $spec ]] && declare -F _completion_loader >/dev/null; then
    _completion_loader "$program" >/dev/null 2>&1
    spec=$(complete -p -- "$program" 2>/dev/null)
fi
COMPREPLY=()
if [[ $spec =~ [[:space:]]-F[[:space:]]([[:alnum:]_][[:alnum:]_.:-]*) ]]; then
    function_name=${BASH_REMATCH[1]}
    if declare -F "$function_name" >/dev/null; then
        "$function_name" "$program" "$current" "$previous" >/dev/null 2>&1
        if (( ${#COMPREPLY[@]} )); then printf '%s\0' "${COMPREPLY[@]:0:80}"; fi
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
