//! Sealing primitives: PBKDF2 key derivation and AES-256-GCM encryption.
//!
//! This is the cryptographic core of article-level encryption, kept free of
//! payload knowledge: bytes in, bytes out, so every rule the artifacts depend
//! on is unit tested without a site. [`seal`] derives a 256-bit key from the
//! password with PBKDF2-HMAC-SHA256 and encrypts the plaintext under a fresh
//! random salt and nonce; [`open`] is the exact inverse.
//!
//! The layout is fixed so the browser can open what the build sealed:
//!
//! - the key is derived with PBKDF2-HMAC-SHA256 over the UTF-8 password and
//!   the 16-byte salt, [`KDF_ITERATIONS`] rounds, into 32 bytes;
//! - AES-256-GCM encrypts the plaintext with the 12-byte nonce and the
//!   additional data `aad`;
//! - the ciphertext is returned as `ciphertext || tag` — the 16-byte GCM tag
//!   appended — which is the same byte order Web Crypto's AES-GCM produces,
//!   so the reader decrypts with no rearrangement.
//!
//! Opening fails unless the tag authenticates: a wrong password, a wrong
//! additional data and a tampered ciphertext are indistinguishable by design,
//! and they all surface as one error. The salt, the nonce and the iteration
//! count are public by nature; the security of a sealed document rests on the
//! password alone.
//!
//! Randomness comes from the operating system (`rand_core::OsRng`), so every
//! sealing operation produces its own salt and nonce — the same document
//! sealed twice never produces the same bytes, which is what keeps two
//! encryptions of the same plaintext unlinkable.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

/// Length of the per-document random salt, in bytes.
pub const SALT_LEN: usize = 16;

/// Length of the AES-GCM nonce, in bytes.
pub const NONCE_LEN: usize = 12;

/// Length of the AES-GCM authentication tag that trails every ciphertext.
pub const TAG_LEN: usize = 16;

/// Length of the derived AES-256 key, in bytes.
pub const KEY_LEN: usize = 32;

/// PBKDF2-HMAC-SHA256 iteration count.
///
/// The OWASP-recommended figure for this configuration; the value travels in
/// every artifact (`iters`) so a future change can stay readable.
pub const KDF_ITERATIONS: u32 = 600_000;

/// Identifier of the key-derivation function, as the artifact carries it.
pub const KDF_NAME: &str = "pbkdf2-sha256";

/// Version of the sealed-artifact format.
pub const FORMAT_VERSION: u8 = 1;

/// The random parameters and the ciphertext of one sealing operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedBytes {
    /// The fresh random salt the key was derived with.
    pub salt: [u8; SALT_LEN],
    /// The fresh random nonce the plaintext was encrypted with.
    pub nonce: [u8; NONCE_LEN],
    /// The ciphertext with the 16-byte authentication tag appended.
    pub ct: Vec<u8>,
}

/// The decoded parameters of a sealed payload, ready for [`open`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedRef<'a> {
    /// The salt the key was derived with.
    pub salt: &'a [u8],
    /// The nonce the plaintext was encrypted with.
    pub nonce: &'a [u8],
    /// The ciphertext with the authentication tag appended.
    pub ct: &'a [u8],
}

/// Why a sealed payload did not open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// The parameters do not fit the format: a salt or nonce of the wrong
    /// length, or a ciphertext shorter than its own tag.
    Malformed,
    /// The tag did not authenticate: the password is wrong, the additional
    /// data does not match, or the bytes were altered.
    Authenticated,
}

impl core::fmt::Display for OpenError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Malformed => f.write_str("sealed parameters do not fit the format"),
            Self::Authenticated => {
                f.write_str("authentication failed: wrong password or altered bytes")
            }
        }
    }
}

/// Seal `plaintext` with `password`, binding `aad` into the tag.
///
/// The salt and the nonce are fresh random bytes of every call; the returned
/// ciphertext carries the tag appended, ready to be encoded into an artifact.
pub fn seal(plaintext: &[u8], password: &str, aad: &[u8]) -> SealedBytes {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let key = derive_key(password, &salt);
    let ct = encrypt(&key, &nonce, plaintext, aad);

    SealedBytes { salt, nonce, ct }
}

/// Open a sealed payload with `password`.
///
/// Succeeds only when the tag authenticates under the key derived from the
/// password and the additional data; every other case is one of the
/// [`OpenError`] variants. The plaintext is returned as owned bytes.
pub fn open(sealed: SealedRef<'_>, password: &str, aad: &[u8]) -> Result<Vec<u8>, OpenError> {
    if sealed.salt.len() != SALT_LEN || sealed.nonce.len() != NONCE_LEN || sealed.ct.len() < TAG_LEN
    {
        return Err(OpenError::Malformed);
    }

    let salt: [u8; SALT_LEN] = sealed.salt.try_into().expect("length checked above");
    let nonce: [u8; NONCE_LEN] = sealed.nonce.try_into().expect("length checked above");
    let nonce = Nonce::from_slice(&nonce);
    let key = derive_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("the key length is fixed");

    cipher
        .decrypt(
            nonce,
            Payload {
                msg: sealed.ct,
                aad,
            },
        )
        .map_err(|_| OpenError::Authenticated)
}

/// Derive the 256-bit key from the UTF-8 password and the salt.
fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, KDF_ITERATIONS, &mut key);
    key
}

/// Encrypt under the derived key; AES-GCM cannot fail for these parameters.
fn encrypt(key: &[u8; KEY_LEN], nonce: &[u8; NONCE_LEN], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("the key length is fixed");
    let nonce = Nonce::from_slice(nonce);

    cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("AES-GCM encryption cannot fail for a valid key and nonce")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The document id every test binds its ciphertext to.
    const AAD: &[u8] = b"guide/intro.md";

    #[test]
    fn a_sealed_payload_opens_to_the_original_plaintext() {
        let plaintext = b"the body html and toc and blocks and text";
        let sealed = seal(plaintext, "global secret", AAD);

        let opened = open(
            SealedRef {
                salt: &sealed.salt,
                nonce: &sealed.nonce,
                ct: &sealed.ct,
            },
            "global secret",
            AAD,
        )
        .expect("the right password and aad open the payload");

        assert_eq!(opened, plaintext);
    }

    #[test]
    fn an_empty_and_a_unicode_plaintext_round_trip() {
        for plaintext in ["", "正文 内容 🎉"] {
            let sealed = seal(plaintext.as_bytes(), "密码", AAD);
            let opened = open(
                SealedRef {
                    salt: &sealed.salt,
                    nonce: &sealed.nonce,
                    ct: &sealed.ct,
                },
                "密码",
                AAD,
            )
            .expect("the payload opens");

            assert_eq!(opened, plaintext.as_bytes());
        }
    }

    #[test]
    fn a_wrong_password_fails_to_authenticate() {
        let sealed = seal(b"secret body", "correct horse", AAD);
        let error = open(
            SealedRef {
                salt: &sealed.salt,
                nonce: &sealed.nonce,
                ct: &sealed.ct,
            },
            "wrong horse",
            AAD,
        )
        .expect_err("a wrong password cannot open the payload");

        assert_eq!(error, OpenError::Authenticated);
    }

    #[test]
    fn a_wrong_additional_data_fails_to_authenticate() {
        let sealed = seal(b"secret body", "global secret", AAD);
        let error = open(
            SealedRef {
                salt: &sealed.salt,
                nonce: &sealed.nonce,
                ct: &sealed.ct,
            },
            "global secret",
            b"other.md",
        )
        .expect_err("ciphertext is bound to its document");

        assert_eq!(error, OpenError::Authenticated);
    }

    #[test]
    fn a_tampered_ciphertext_fails_to_authenticate() {
        let plaintext = b"secret body";
        let sealed = seal(plaintext, "global secret", AAD);

        for (name, tampered) in [
            ("flipped payload byte", {
                let mut ct = sealed.ct.clone();
                ct[0] ^= 0x01;
                ct
            }),
            ("flipped tag byte", {
                let mut ct = sealed.ct.clone();
                let last = ct.len() - 1;
                ct[last] ^= 0x01;
                ct
            }),
            ("truncated tag", sealed.ct[..sealed.ct.len() - 1].to_vec()),
        ] {
            let error = open(
                SealedRef {
                    salt: &sealed.salt,
                    nonce: &sealed.nonce,
                    ct: &tampered,
                },
                "global secret",
                AAD,
            )
            .expect_err("tampered bytes must not open");

            assert_eq!(error, OpenError::Authenticated, "{name}");
        }
    }

    #[test]
    fn malformed_parameters_are_rejected_before_the_key_is_derived() {
        let sealed = seal(b"secret body", "global secret", AAD);
        let full = SealedRef {
            salt: &sealed.salt,
            nonce: &sealed.nonce,
            ct: &sealed.ct,
        };

        let short_salt = SealedRef {
            salt: &sealed.salt[..SALT_LEN - 1],
            nonce: full.nonce,
            ct: full.ct,
        };
        let short_nonce = SealedRef {
            salt: full.salt,
            nonce: &sealed.nonce[..NONCE_LEN - 1],
            ct: full.ct,
        };
        let bare_tag = SealedRef {
            salt: full.salt,
            nonce: full.nonce,
            ct: &sealed.ct[..TAG_LEN - 1],
        };

        for params in [short_salt, short_nonce, bare_tag] {
            let error = open(params, "global secret", AAD)
                .expect_err("malformed parameters cannot open anything");

            assert_eq!(error, OpenError::Malformed);
        }
    }

    #[test]
    fn every_sealing_produces_its_own_salt_and_nonce() {
        let first = seal(b"same plaintext", "same password", AAD);
        let second = seal(b"same plaintext", "same password", AAD);

        assert_ne!(first.salt, second.salt, "salts are fresh per call");
        assert_ne!(first.nonce, second.nonce, "nonces are fresh per call");
        assert_ne!(first.ct, second.ct, "the ciphertexts differ too");
    }

    #[test]
    fn the_ciphertext_hides_the_plaintext_and_carries_the_tag() {
        let plaintext = b"a very distinctive plaintext marker";
        let sealed = seal(plaintext, "global secret", AAD);

        assert!(
            !sealed
                .ct
                .windows(plaintext.len())
                .any(|window| window == plaintext),
            "the plaintext must not survive verbatim in the ciphertext"
        );
        assert_eq!(sealed.ct.len(), plaintext.len() + TAG_LEN);
        assert_eq!(sealed.salt.len(), SALT_LEN);
        assert_eq!(sealed.nonce.len(), NONCE_LEN);
    }

    #[test]
    fn the_documented_constants_travel_in_the_artifact() {
        assert_eq!(FORMAT_VERSION, 1);
        assert_eq!(KDF_NAME, "pbkdf2-sha256");
        assert_eq!(KDF_ITERATIONS, 600_000);
        assert_eq!(KEY_LEN, 32);
    }

    #[test]
    fn open_errors_are_human_readable() {
        assert_eq!(
            OpenError::Malformed.to_string(),
            "sealed parameters do not fit the format"
        );
        assert_eq!(
            OpenError::Authenticated.to_string(),
            "authentication failed: wrong password or altered bytes"
        );
    }
}
