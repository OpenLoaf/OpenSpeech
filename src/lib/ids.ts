// 本地记录 ID 生成器：日期增量 + 短随机。
//
// 格式：`YYYYMMDDHHMMSSmmm-xxxx`（17 位本地时间到毫秒 + 4 位 base36 随机）
// 例："20260424140521438-a3b9"
//
// 特性：
// - 字典序 == 时间序：SQLite 里按 id 排 = 按时间排，文件系统里按文件名排也同序。
// - 可读：从 id 本身就能一眼读出是哪一天、哪个时间段的录音，排查"某天那条怎么丢了"非常直接。
// - 免 DB 查询：前端直接生成；毫秒 + 4 位 base36 随机让同毫秒碰撞概率 ≈ 1/1.6M。
// - 跨模块共用：history / dictionary / 其他未来本地记录都走同一规则，统一好找。
//
// 本地时间（非 UTC）：ID 的主用途是给用户自己检索，本地时区更直观。

export function newId(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const prefix =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    pad(d.getMilliseconds(), 3);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}-${rand}`;
}
