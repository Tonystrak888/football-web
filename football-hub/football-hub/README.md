# Football Hub — ระบบดึงข้อมูลสด 24/7 + แจ้งเตือน

หน้าเว็บเดิม (`index.html`) ตอนนี้ดึงข้อมูลสดจาก **backend ของตัวเอง** (`server.js`) แทนข้อมูลที่พิมพ์ฝังไว้
backend ดึง **API-Football** ตลอดเวลา ตรวจจับเหตุการณ์ใหม่ แล้วส่ง **Telegram** (และ webhook) ได้แม้ไม่มีใครเปิดเว็บ

```
API-Football ──► server.js (worker 24/7) ──► Telegram / webhook   (ประตู ใบแดง เริ่ม พักครึ่ง จบ)
                      │
                      ├─ /api/feed      โปรแกรม+สกอร์สดทั่วโลก (หน้าเว็บดึงทุก 15 วิ)
                      ├─ /api/leagues   ตาราง/ผลล่าสุด/โปรแกรมถัดไป/% โอกาสชนะ ของ 9 ลีก
                      ├─ /api/match/:id เหตุการณ์ สถิติ ผู้เล่น
                      └─ /          เสิร์ฟ index.html
```

ไม่ต้อง `npm install` — ใช้ Node.js 18 ขึ้นไปอย่างเดียว

## 1) ลองก่อนด้วยข้อมูลจำลอง (ไม่ต้องมี API key)

```bash
MOCK=1 node server.js
# เปิด http://localhost:3000  — จะเห็นแมตช์จำลองที่เตะและยิงประตูทุกวินาที (1 วิ = 1 นาที)
```

## 2) ใช้ข้อมูลจริง

1. สมัคร https://dashboard.api-football.com เอา API key
2. `cp .env.example .env` แล้วใส่ `API_FOOTBALL_KEY=...`
3. `node server.js` แล้วเช็ก `http://localhost:3000/api/health` (ดู `quota` กับ `updated`)

### ตั้ง Telegram
1. คุยกับ **@BotFather** → `/newbot` → ได้ token ใส่ `TELEGRAM_BOT_TOKEN`
2. ทักบอทของคุณ 1 ข้อความ (หรือเชิญบอทเข้ากลุ่ม) แล้วหา chat id (เช่นเปิด `https://api.telegram.org/bot<TOKEN>/getUpdates`) ใส่ `TELEGRAM_CHAT_ID`
3. ตั้ง `ADMIN_TOKEN` แล้วทดสอบ: `curl -X POST "http://localhost:3000/api/notify/test?token=<ADMIN_TOKEN>"`

ขอบเขตแจ้งเตือนตั้งที่ `NOTIFY_MODE` (`leagues` = 9 ลีกที่ติดตาม, `teams` = เฉพาะ `NOTIFY_TEAMS`, `all` = ทุกแมตช์ทั่วโลก ข้อความเยอะมาก)
ตอน server เพิ่งสตาร์ทมันจะไม่แจ้งเหตุการณ์เก่าที่เกิดไปแล้ว (กันรัว) และจำเหตุการณ์ที่แจ้งไปแล้วใน `data/state.json` ข้าม restart

## 3) ขึ้นเซิร์ฟเวอร์ให้รัน 24/7 (VPS)

```bash
# บน Ubuntu/Debian (ติดตั้ง Node 20+ ตามวิธีของ nodesource หรือ nvm ก่อน)
sudo useradd -r -m -d /opt/football-hub footballhub
sudo cp -r ./* .env /opt/football-hub/ && sudo chown -R footballhub: /opt/football-hub
sudo cp football-hub.service /etc/systemd/system/
sudo systemctl enable --now football-hub
journalctl -u football-hub -f          # ดู log
```

โดเมน + HTTPS: ชี้ DNS (A record) ไปที่ IP ของ VPS แล้วใช้ Caddy (ออกใบรับรองให้อัตโนมัติ)
ดู `Caddyfile` — แก้ชื่อโดเมน, ตั้ง `TRUST_PROXY=1` ใน `.env`

## โควตา API (สำคัญ)

ค่าเริ่มต้นประมาณ: live ทุก 30 วิ (~2,900 คำขอ/วัน ถ้ามีแมตช์เตะตลอด) + โปรแกรม ~290 + ลีก ~450 ≈ **3.5–4 พันคำขอ/วัน**
แพ็กเกจฟรี (ประมาณ 100/วัน) **ไม่พอ** สำหรับ 24/7 — ดูแพ็กเกจและโควตาล่าสุดที่หน้าราคาของ API-Football
ถ้าโควตาน้อยกว่านี้ให้เพิ่ม `LIVE_POLL_SEC` (เช่น 60) หรือตั้ง `PREDICTIONS=0`
ถ้าโควตาเหลือต่ำกว่า ~40 ระบบจะชะลอเองและหยุดงานที่ไม่จำเป็น

## อะไรเปลี่ยนใน index.html

- ตั้ง `window.FH_BASE="https://..."` ก่อนสคริปต์ท้ายไฟล์ ถ้า backend อยู่คนละโดเมน (ค่าเริ่มต้น = โดเมนเดียวกัน)
- โปรแกรม/สกอร์สดวันนี้มาจาก `/api/feed` ทั้งหมด (ข้อมูล `TODAY` เดิมจะถูกแทนที่เมื่อ backend ตอบได้)
- ตารางคะแนน ผลล่าสุด โปรแกรมถัดไป และ % โอกาสชนะ ของ 9 ลีก มาจาก `/api/leagues` (หน้า วิเคราะห์ คำนวณต่อจากข้อมูลนี้ให้เอง)
- ถ้า backend ล่ม หน้าเว็บจะยังแสดงข้อมูลล่าสุด/ข้อมูลเดิมในไฟล์ และขึ้นแถบแจ้งที่ท้ายหน้า
- ทีมโปรด (ดาว ☆) จะมี popup แจ้งในหน้าเว็บเมื่อสกอร์เปลี่ยนขณะเปิดหน้าอยู่

## ข้อควรรู้ / ต้องเช็กตอนใช้จริง

- ผมทดสอบกับ **ข้อมูลจำลองที่จำลองรูปแบบ response ตามเอกสาร API-Football** เท่านั้น (เครื่องที่ใช้เขียนต่อเน็ตภายนอกไม่ได้) ครั้งแรกที่ใส่คีย์จริงให้ดู log และ `/api/health` ถ้า field ไหนไม่ตรง (เช่นชื่อสถิติ, `predictions`) แก้ได้ที่ฟังก์ชัน `normFixture` / `mapStats` / `ensurePred` ใน `server.js`
- ID ลีกที่ติดตามอยู่ใน `LEAGUES` (39 EPL, 140 ลาลีกา, 135 เซเรีย อา, 78 บุนเดส, 61 ลีเอิง, 2 UCL, 296 ไทยลีก 1, 98 เจ1, 253 MLS) — เช็กกับ `GET /leagues` ได้ว่าลีกไหนมี coverage ของ events/standings
- ชื่อทีมจาก API ถูกแปลงเป็นชื่อสั้นเดิมของหน้าเว็บด้วย `ALIASES` (ใน `server.js`) เพิ่มเองได้ใน `aliases.json` เช่น `{"Some FC":"Some"}` ทีมที่ยังไม่ได้ map จะใช้ชื่อเต็มจาก API
- ตรวจสอบเงื่อนไขการใช้ข้อมูลของ API-Football ก่อนเปิดให้คนทั่วไปใช้เชิงพาณิชย์
- Web Push (แจ้งเตือนบนมือถือผู้ใช้ทั่วไป) และ LINE ยังไม่ได้ทำ — ตอนนี้แจ้งผ่าน Telegram/webhook เท่านั้น
