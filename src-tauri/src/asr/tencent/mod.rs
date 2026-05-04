// 腾讯云 ASR 直连实现（BYOK 模式）。
//
// 凭证三件套：AppID + SecretId + SecretKey
//   - AppID: 实时 WS 路径 `/asr/v2/<appid>` 一部分（非密钥，可放普通 store）
//   - SecretId: 标识身份，进 query / Authorization header（非密钥）
//   - SecretKey: HMAC 派生用，**必须** keyring 存
//
// 两套签名算法：
//   - 实时 WS:    HMAC-SHA1(SecretKey, signing_string) → base64 → URL-encode
//   - REST v3:    TC3-HMAC-SHA256，按官方 4 步派生（Date → Service → tc3_request → Signature）
// 详见 signature.rs。

pub mod file;
pub mod realtime;
pub mod realtime_session;
pub mod signature;
