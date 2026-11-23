point=$1
line=$2
kind=$3
provider=$4
shift 4
prefix=${!#}

if (( $# == 1 )) && [[ $prefix != */* ]]; then
    while IFS= read -r item; do
        printf 'N%s\0' "$item"
    done < <(compgen -c -- "$prefix" | LC_ALL=C /usr/bin/sort -u | /usr/bin/head -n 40)
elif [[ $kind != directory && -n $provider ]]; then
    found=false
    while IFS= read -r -d '' item; do
        printf 'N%s\0' "$item"
        found=true
    done < <(/bin/bash --noprofile --norc -c "$provider" dirlume-completion "$point" "$line" "$@")
    $found && exit 0
fi

[[ $kind == none ]] && exit 0

base=
name=$prefix
if [[ $prefix == */* ]]; then
    base=${prefix%/*}/
    name=${prefix##*/}
fi
directory=${base:-.}
if [[ $directory == '~/'* ]]; then
    directory=$HOME/${directory#\~/}
fi

shopt -s nullglob
count=0
for item in "$directory"/"$name"*; do
    label=$base${item##*/}
    if [[ -d $item ]]; then
        label+=/
    elif [[ $kind == directory ]]; then
        continue
    fi
    printf 'P%s\0' "$label"
    (( ++count == 60 )) && break
done
exit 0
