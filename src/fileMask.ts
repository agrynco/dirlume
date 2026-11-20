export function fileMask(mask: string) {
  const pattern = [...mask.toLowerCase()];
  return (name: string) => {
    const letters = [...name.toLowerCase()];
    let fileIndex = 0;
    let maskIndex = 0;
    let wildcard = -1;
    let wildcardEnd = 0;
    // Only the most recent '*' can consume another character.
    while (fileIndex < letters.length) {
      if (pattern[maskIndex] === "*") {
        wildcard = maskIndex++;
        wildcardEnd = fileIndex;
      } else if (pattern[maskIndex] === "?" || pattern[maskIndex] === letters[fileIndex]) {
        fileIndex++;
        maskIndex++;
      } else if (wildcard >= 0) {
        maskIndex = wildcard + 1;
        fileIndex = ++wildcardEnd;
      } else {
        return false;
      }
    }
    while (pattern[maskIndex] === "*") maskIndex++;
    return maskIndex === pattern.length;
  };
}
