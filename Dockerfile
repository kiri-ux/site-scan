# Official Playwright image: Chromium + all system deps preinstalled.
# Tag must match the playwright version in requirements.txt (1.64.1).
FROM mcr.microsoft.com/playwright/python:v1.64.1-jammy

# Refresh the system CA store (Oct 2026 eMudhra intermediate compromise).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render injects PORT; default to 10000 for local docker runs.
ENV PORT=10000
CMD gunicorn app:app --bind 0.0.0.0:$PORT --timeout 180 --workers 1 --threads 4 --access-logfile - --error-logfile -
