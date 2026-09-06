# Going live — dattendance.dolluzcorp.com

Same shape as the dAssist runbook. Differences from it, up front:

| | dAssist | dAttendance |
|---|---|---|
| Backend port | 4001 | **4010** |
| Uploaded files | `Tickets_file_uploads/` | **none** — no upload location in the vhost |
| Database | existing | **`001`, `002` and `004` must run before anyone can sign in** |
| Sign-in | password | **password + a code emailed via SendGrid** |

---

## 0. Before you start

**DNS.** `dattendance.dolluzcorp.com` needs an A record pointing at
`64.227.135.222`. Certbot validates over HTTP and will fail without it.

**Port 4010.** The original bundle listed dTprm on 4010. Check nothing already
holds it:

```bash
pm2 list
sudo ss -lptn 'sport = :4010'
```

If it is taken, change `DATTENDANCE_PORT` in `.env` **and** the `proxy_pass`
line in the vhost together.

**The SQL.** Run `sql/001`, `sql/002` and `sql/004` in Workbench first.

- `001` creates the `dattendance` database. Safe to re-run.
- `002` adds `dadmin.employee.app_dAttendance`, which the login query reads —
  without it every sign-in returns 500. **Not idempotent; run it once.**
- `004` creates `att_otp` and `att_trusted_device` for the emailed sign-in code
  and "Remember for 14 days". Without it sign-in fails at the second step.
  Safe to re-run.

---

## 1. Push the code

The repo lives at `https://github.com/dolluzcorp01/dAttendance` on `main`.
From your machine:

```bash
cd c:/Users/91638/Desktop/Dolluzcorp/dApps/dAttendance/dattendance
git add -A
git commit -m "..."
git push
```

`.env` and `build/` are gitignored, so both are created on the droplet.

---

## 2. Server directory

```bash
ssh root@64.227.135.222

cd /var/www/dolluzcorp.com
mkdir dattendance
```

---

## 3. nginx — HTTP only, so certbot has something to work with

```bash
sudo nano /etc/nginx/sites-available/dattendance.dolluzcorp.com
```

```nginx
server {
    listen 80;
    server_name dattendance.dolluzcorp.com;
    root /var/www/dolluzcorp.com/dattendance/build;
    index index.html;

    location / { try_files $uri $uri/ /index.html; }

    location /api/ {
        proxy_pass http://localhost:4010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/dattendance.dolluzcorp.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d dattendance.dolluzcorp.com
```

Certbot rewrites the file with the SSL block. Step 4 replaces it with the full
version — keep the two `ssl_certificate` paths certbot just wrote.

---

## 4. nginx — the full vhost

```bash
sudo nano /etc/nginx/sites-available/dattendance.dolluzcorp.com
```

```nginx
# Main SSL server block for dattendance.dolluzcorp.com
server {
    server_name dattendance.dolluzcorp.com;
    root /var/www/dolluzcorp.com/dattendance/build;
    index index.html;

    # Server maintenance
    set $app_name "dAttendance";

    error_page 403 404 500 502 503 504 /maintenance.html;

    location = /maintenance.html {
        root /var/www/dolluzcorp.com/maintenance;
        sub_filter '__APP_NAME__' $app_name;
        sub_filter_once off;
        sub_filter_types text/html;
        internal;
    }

    location = /favicon.png {
        root /var/www/dolluzcorp.com/maintenance;
    }

    # Hashed build assets are immutable - cache hard
    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Never cache the HTML shell - new builds load at once
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate" always;
    }

    # The favicon set lives at the web root, not under /static/
    location ~* ^/(favicon\.ico|logo64\.png|logo192\.png|logo512\.png|manifest\.json)$ {
        expires 7d;
        access_log off;
    }

    # React routing
    location / {
       if (-f /var/www/dolluzcorp.com/dattendance/MAINTENANCE) { return 503; }
       try_files $uri $uri/ @react;
    }

    location @react {
       add_header Cache-Control "no-store, must-revalidate" always;

       if (-f /var/www/dolluzcorp.com/dattendance/build/index.html) {
         rewrite ^ /index.html break;
       }

       return 503;
    }

    # Proxy API requests to the dAttendance backend
    location /api/ {
        proxy_pass http://localhost:4010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    listen 443 ssl; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

    ssl_certificate /etc/letsencrypt/live/dattendance.dolluzcorp.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/dattendance.dolluzcorp.com/privkey.pem; # managed by Certbot
}

# Redirect all HTTP requests to HTTPS
server {
    if ($host = dattendance.dolluzcorp.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name dattendance.dolluzcorp.com;
    return 404; # managed by Certbot
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

`X-Forwarded-For` matters here: `server.js` sets `trust proxy`, and the
activity log records `req.ip`. Without the header every row reads `127.0.0.1`.

There is no uploads location — dAttendance stores no files. Downloads are CSV
generated in memory by `/api/sheet/download`.

---

## 5. Code and environment

```bash
cd /var/www/dolluzcorp.com/dattendance

git init
git remote add origin https://github.com/dolluzcorp01/dAttendance.git
git pull origin main

nano .env
```

```
REACT_APP_API=https://dattendance.dolluzcorp.com

DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=dattendance

# MUST be byte-identical to dAdmin's, or a session from Inside D will not verify.
JWT_SECRET=

DATTENDANCE_PORT=4010

# Sign-in codes and password-reset codes go out through SendGrid. Copy the key
# from dAdmin's .env — same account. WITHOUT IT NOBODY CAN SIGN IN: the server
# refuses to issue a code in production rather than print it to a log.
SENDGRID_API_KEY=
DATTENDANCE_FROM_EMAIL="dAttendance" <connect@dolluzcorp.com>
OTP_LENGTH=6
BCRYPT_ROUNDS=10

# Turns on Secure + SameSite=None cookies and drops the localhost CORS bypass.
# server.js loads dotenv before it reads this, so setting it here is enough,
# and react-scripts build is unaffected by it.
NODE_ENV=production
```

> **Server `.env` only.** Do not put `NODE_ENV=production` in your local
> `.env`. It makes the login cookie `Secure`, which a browser refuses to store
> over `http://localhost`, and you will be unable to sign in on your machine.

Copy `DB_*`, `JWT_SECRET` and `SENDGRID_API_KEY` from the dAdmin `.env` already
on this box — dAttendance shares all four:

```bash
grep -E '^(DB_HOST|DB_USER|DB_PASSWORD|JWT_SECRET|SENDGRID_API_KEY)=' /var/www/dolluzcorp.com/dadmin/.env
```

---

## 6. Install and build

```bash
npm install
NODE_OPTIONS="--max-old-space-size=3072" npm run build
```

Backend dependencies: `express cookie-parser cors dotenv jsonwebtoken bcryptjs
mysql2`. They are all in `package.json`, so `npm install` covers them — but run
the server by hand once before pm2, so a missing module shows up as an error you
can read rather than a pm2 restart loop:

```bash
node server.js
# expect: 🚀 dAttendance server running at http://localhost:4010
# Ctrl-C once you see it
```

Confirm it answers before handing it to pm2:

```bash
curl -s http://localhost:4010/api/health
# {"ok":true,"app":"dAttendance","port":"4010"}
```

---

## 7. pm2

```bash
pm2 start server.js --name dattendance-backend
pm2 save
pm2 startup
```

---

## 8. Verify

```bash
curl -sI https://dattendance.dolluzcorp.com | head -1          # 200
curl -s  https://dattendance.dolluzcorp.com/api/health         # {"ok":true,...}
pm2 logs dattendance-backend --lines 30
```

Then in a browser:

1. `https://dattendance.dolluzcorp.com` → login page with the Dolluz lockup.
2. Sign in with a real employee ID. **A 500 here means `sql/002` has not run.**
3. The sheet loads for the current month. If the amber "No holidays are
   configured in dTime for this month" banner appears, that is a real defect
   signal, not decoration — seed `dtime.holidays` before anyone submits, or
   every weekday counts as a working day and the payroll numbers are wrong.
4. Click a working day → the Present / Leave menu opens.

---

## Maintenance switch

```bash
touch    /var/www/dolluzcorp.com/dattendance/MAINTENANCE   # on
rm       /var/www/dolluzcorp.com/dattendance/MAINTENANCE   # off
```

## Rollback

```bash
cd /var/www/dolluzcorp.com/dattendance
git log --oneline -5
git checkout <sha>
NODE_OPTIONS="--max-old-space-size=3072" npm run build
pm2 restart dattendance-backend
```
