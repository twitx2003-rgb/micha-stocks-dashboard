# פריסה לענן

האתר מוכן לפריסה כשרת Node אחד. הדרך הפשוטה לקישור קבוע היא Render או Railway.

## Render

1. מעלים את התיקייה הזו ל-GitHub.
2. ב-Render בוחרים New Web Service.
3. מחברים את ה-repository.
4. Render יזהה את `render.yaml` ויבנה Docker אוטומטית.
5. אחרי הפריסה תקבל כתובת קבועה בסגנון:

```text
https://micha-stocks-dashboard.onrender.com
```

הקובץ `render.yaml` מגדיר דיסק קטן בנתיב `/app/data`, כדי שה- Universe וה-snapshot של הניתוח האחרון יישמרו בין הפעלות.

## Railway / VPS

אפשר להריץ גם בכל שרת שתומך ב-Docker:

```bash
docker build -t micha-stocks-dashboard .
docker run -p 4173:4173 -v dashboard-data:/app/data micha-stocks-dashboard
```

ואז מחברים דומיין או reverse proxy ל-port של השרת.

## הערה חשובה

כדי ליצור לך כתובת ציבורית אמיתית מתוך Render/Railway צריך חשבון מחובר וסביבת פריסה. הקוד כבר מוכן לזה, אבל יצירת הכתובת עצמה נעשית דרך חשבון הענן שלך.
