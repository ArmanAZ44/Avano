# راهنمای مشارکت | Contributing

ممنون که می‌خواهید به آوانو کمک کنید. 💜
این راهنما کوتاه است تا سریع شروع کنید.

---

## 🇮🇷 فارسی

### پیش از شروع

- برای **رفع اشکال** یا **قابلیت جدید** اول یک Issue باز کنید تا رویکرد را هم‌راستا کنیم.
- تغییرات کوچک (غلط تایپی، متن، ترجمه) را می‌توانید مستقیم PR بزنید.

### راه‌اندازی محیط

```bash
git clone https://github.com/ArmanAZ44/Avano.git
cd Avano
node tools/validate.mjs     # بررسی سلامت سورس و manifest
node tools/build.mjs        # ساخت بسته‌ها در dist/
```

نیازمندی: Node.js نسخه‌ی ۱۸ یا بالاتر. هیچ وابستگی npm لازم نیست.

### بارگذاری در مرورگر

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → پوشه‌ی مخزن.

**Firefox:** `npm run build` و بعد فایل `dist/Avano-<version>-firefox.xpi` را از `about:debugging` بارگذاری کنید.

### قواعد کد

| قاعده | چرا |
|---|---|
| **هر فایل جدیدی که افزونه لازم دارد باید در `manifest.json` و `manifest-v2.json` هر دو ثبت شود** | وگرنه در یکی از دو مرورگر بی‌صدا شکست می‌خورد |
| متن‌های کاربر با **فارسی روان**، بدون اصطلاح فنی | مخاطب اصلی کاربر عادی است |
| اگر API مرورگری در فایرفاکس نیست، در `src/shared/browser-api.js` پوش بدهید | یک سورس برای هر دو مرورگر |
| رنگ‌ها و فونت را از پالت موجود بردارید (بنفش + وزیرمتن) | یکدستی ظاهر |
| `console.log` اضافه نگذارید | کنسول کاربر شلوغ نشود |

### پیش از ارسال PR

```bash
node tools/validate.mjs --strict
node tools/build.mjs
```

اگر رابط کاربری را عوض کردید، اسکرین‌شات‌های `docs/img/` را به‌روز کنید (اسکریپت‌های رندر در پوشه‌ی `.shots/` نمونه دارند).

### نسخه‌گذاری

از [Semantic Versioning](https://semver.org/lang/fa/): `MAJOR.MINOR.PATCH`.
نسخه باید در `package.json`، `manifest.json` و `manifest-v2.json` یکی باشد — `validate.mjs` این را چک می‌کند.

---

## 🇬🇧 English

### Before you start

- Open an issue first for **bug fixes** and **features** so we can agree on the approach.
- Small changes (typos, copy, translations) can go straight to a PR.

### Getting set up

```bash
git clone https://github.com/ArmanAZ44/Avano.git
cd Avano
node tools/validate.mjs     # sanity-check sources and manifests
node tools/build.mjs        # build both packages into dist/
```

Requires Node.js 18+. There are no npm dependencies.

### Loading it in a browser

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → the repo folder.

**Firefox:** run `npm run build`, then load `dist/Avano-<version>-firefox.xpi` from `about:debugging`.

### Code rules

| Rule | Why |
|---|---|
| **Any new file the extension needs must be registered in both `manifest.json` and `manifest-v2.json`** | Otherwise one browser silently breaks |
| User-facing copy should be **plain, friendly Persian**, no jargon | Most users are non-technical |
| Missing browser APIs get a shim in `src/shared/browser-api.js` | One source tree for both browsers |
| Take colours and fonts from the existing palette (purple + Vazirmatn) | Visual consistency |
| No stray `console.log` | Keep the user's console clean |

### Before opening a PR

```bash
node tools/validate.mjs --strict
node tools/build.mjs
```

If you changed the UI, refresh the screenshots in `docs/img/` (the `.shots/` folder has example render scripts).

### Versioning

[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
The version must match across `package.json`, `manifest.json` and `manifest-v2.json` — `validate.mjs` enforces this.
