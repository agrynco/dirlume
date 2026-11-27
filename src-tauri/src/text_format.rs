use serde::{Deserialize, Serialize};

pub(crate) const TEXT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Encoding {
    #[default]
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

pub(crate) enum DecodeError {
    Unsupported(String),
    Binary,
}

pub(crate) fn decode(bytes: Vec<u8>) -> Result<(String, Encoding), DecodeError> {
    let (text, encoding) = if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            String::from_utf8(bytes.to_vec())
                .map_err(|error| DecodeError::Unsupported(error.to_string()))?,
            Encoding::Utf8Bom,
        )
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let (chunks, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(DecodeError::Unsupported(
                "The UTF-16 file ends with an incomplete character.".to_owned(),
            ));
        }
        let words: Vec<_> = chunks
            .iter()
            .map(|&pair| {
                if little {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            })
            .collect();
        (
            String::from_utf16(&words)
                .map_err(|error| DecodeError::Unsupported(error.to_string()))?,
            if little {
                Encoding::Utf16Le
            } else {
                Encoding::Utf16Be
            },
        )
    } else {
        (
            String::from_utf8(bytes).map_err(|_| {
                DecodeError::Unsupported(
                    "The file is outside the supported UTF-8 and UTF-16 text formats.".to_owned(),
                )
            })?,
            Encoding::Utf8,
        )
    };
    if text.contains('\0') {
        return Err(DecodeError::Binary);
    }
    Ok((text, encoding))
}

pub(crate) fn encode(encoding: Encoding, text: &str) -> Vec<u8> {
    let mut buffer = Vec::new();
    match encoding {
        Encoding::Utf8 => buffer.extend_from_slice(text.as_bytes()),
        Encoding::Utf8Bom => {
            buffer.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            buffer.extend_from_slice(text.as_bytes());
        }
        Encoding::Utf16Be | Encoding::Utf16Le => {
            let little = matches!(encoding, Encoding::Utf16Le);
            buffer.extend_from_slice(if little { &[0xff, 0xfe] } else { &[0xfe, 0xff] });
            for word in text.encode_utf16() {
                buffer.extend_from_slice(&if little {
                    word.to_le_bytes()
                } else {
                    word.to_be_bytes()
                });
            }
        }
    }
    buffer
}
