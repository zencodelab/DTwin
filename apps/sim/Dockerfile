FROM python:3.12-slim

WORKDIR /app

# Dependencies first so a source edit does not invalidate the wheel install.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Not root. The debian-slim base has no unprivileged user of its own, so one is
# created; the worker only reads its source and talks to Postgres.
RUN adduser --system --no-create-home --group sim \
 && chown -R sim:sim /app
USER sim

EXPOSE 8000

# The worker is useless without the database — it reads the model from it and
# writes every result back — so /healthz checks the connection and answers 503
# when it cannot be reached.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
