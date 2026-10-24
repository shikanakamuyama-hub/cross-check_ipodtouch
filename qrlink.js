/* 2点照合ツール：QRコードでデータを受け渡す（iPod touch 版とパソコン用の画面で共通）
   文字（UTF-8）→ 圧縮（pako）→ 英大文字と数字（Base32）→ 480文字ずつに分けて、1枚ずつQRにする。
   スキャナはキーボードとして文字を送るので、どのキーボード設定でも同じになる 英大文字と数字 だけを使う。
   1枚の中身：NT ＋ 種類（L=出荷リスト／R=記録）＋ 組の番号4文字 ＋ 何枚目2けた ＋ 全部で何枚2けた ＋ 確かめ用2文字 ＋ データ
   iOS 9 の Safari でも動くように、古い書き方（ES5）だけで書いている。 */
var QRLINK = (function () {
  "use strict";
  var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var CHUNK = 480;

  function utf8Bytes(str) {
    var s = unescape(encodeURIComponent(str)), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function utf8String(bytes) {
    var s = "", step = 4096;
    for (var i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, Math.min(bytes.length, i + step))));
    }
    return decodeURIComponent(escape(s));
  }
  function b32enc(bytes) {
    var out = "", bits = 0, val = 0;
    for (var i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += B32.charAt((val >>> (bits - 5)) & 31); bits -= 5; }
      val &= 255;
    }
    if (bits > 0) out += B32.charAt((val << (5 - bits)) & 31);
    return out;
  }
  function b32dec(str) {
    var out = [], bits = 0, val = 0;
    for (var i = 0; i < str.length; i++) {
      var c = B32.indexOf(str.charAt(i));
      if (c < 0) throw new Error("使えない文字があります");
      val = (val << 5) | c; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
      val &= 255;
    }
    return new Uint8Array(out);
  }
  function check(s) {
    var h = 7;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1024;
    return B32.charAt(h >> 5) + B32.charAt(h & 31);
  }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function newId() {
    var s = "";
    for (var i = 0; i < 4; i++) s += B32.charAt(Math.floor(Math.random() * 32));
    return s;
  }

  // 文字を、QRに入れる文字の配列にする
  function pack(kind, text) {
    var data = b32enc(pako.deflateRaw(utf8Bytes(text), { level: 9 }));
    var size = Math.max(CHUNK, Math.ceil(data.length / 99));
    var n = Math.max(1, Math.ceil(data.length / size)), id = newId(), out = [];
    for (var i = 0; i < n; i++) {
      var part = data.substr(i * size, size);
      out.push("NT" + kind + id + pad2(i + 1) + pad2(n) + check(part) + part);
    }
    return out;
  }
  // スキャナで読んだ1枚を調べる。{ kind, id, idx, total, part } か { error }
  function parse(raw) {
    var s = String(raw == null ? "" : raw).replace(/[\s\r\n]/g, "").toUpperCase();
    var m = /^NT([LR])([A-Z2-7]{4})(\d\d)(\d\d)([A-Z2-7]{2})([A-Z2-7]*)$/.exec(s);
    if (!m) return { error: s.indexOf("NT") === 0 ? "QRの中身が欠けています（読み直してください）" : "受け渡し用のQRではありません" };
    var idx = parseInt(m[3], 10), total = parseInt(m[4], 10);
    if (idx < 1 || idx > total) return { error: "QRの番号がおかしいです" };
    if (check(m[6]) !== m[5]) return { error: "QRの中身が欠けています（読み直してください）" };
    return { kind: m[1], id: m[2], idx: idx, total: total, part: m[6] };
  }
  // 何枚かのQRを集める
  function Collector(kind) {
    this.kind = kind; this.id = ""; this.total = 0; this.parts = [];
  }
  Collector.prototype.add = function (raw) {
    var c = parse(raw);
    if (c.error) return { ok: false, msg: c.error };
    if (c.kind !== this.kind) return { ok: false, msg: this.kind === "L" ? "これは記録のQRです（出荷リストのQRを読んでください）" : "これは出荷リストのQRです（記録のQRを読んでください）" };
    var restarted = false;
    if (c.id !== this.id) {
      // 別の組のQR（新しく作り直したもの）なら、最初から集め直す
      restarted = this.id !== "" && this.count() > 0;
      this.id = c.id; this.total = c.total; this.parts = [];
    }
    var dup = !!this.parts[c.idx - 1];
    this.parts[c.idx - 1] = c.part;
    return { ok: true, idx: c.idx, total: c.total, dup: dup, restarted: restarted, done: this.count() === this.total };
  };
  Collector.prototype.count = function () {
    var n = 0;
    for (var i = 0; i < this.total; i++) if (this.parts[i]) n++;
    return n;
  };
  Collector.prototype.missing = function () {
    var a = [];
    for (var i = 0; i < this.total; i++) if (!this.parts[i]) a.push(i + 1);
    return a;
  };
  Collector.prototype.text = function () {
    return utf8String(pako.inflateRaw(b32dec(this.parts.join(""))));
  };

  // QRを canvas に描く（px：だいたいの大きさ）
  function draw(canvas, text, px) {
    var q = qrcode(0, "L");
    q.addData(text, "Alphanumeric");
    q.make();
    var n = q.getModuleCount(), cell = Math.max(2, Math.floor(px / (n + 8))), size = cell * (n + 8);
    canvas.width = size; canvas.height = size;
    var g = canvas.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, size, size);
    g.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
    return n;
  }

  return { pack: pack, parse: parse, Collector: Collector, draw: draw, utf8Bytes: utf8Bytes, utf8String: utf8String, b32enc: b32enc, b32dec: b32dec };
})();
