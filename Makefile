# Thin wrappers around the root npm scripts so `make` and `npm run` behave the same.
# On Windows without make, run `npm run <target>` instead.
PY ?= python
COMPOSE = docker compose -f infra/docker-compose.yml

.PHONY: setup env gen check up down logs test test-strict lint format seed demo

setup:            ## install node deps and the python venv
	npm run setup
	$(PY) -m venv .venv
	.venv/bin/python -m pip install -r ml/requirements-dev.txt -e tools[dev] || .venv/Scripts/python -m pip install -r ml/requirements-dev.txt -e tools[dev]

env:              ## create .env with generated secrets
	npm run env:init

gen:              ## regenerate constants, test vectors and Wokwi projects
	$(PY) tools/gen_constants.py
	node tools/gen_vectors.js
	$(PY) tools/gen_wokwi.py

check:            ## fail if generated files are stale
	$(PY) tools/gen_constants.py --check
	node tools/gen_vectors.js --check
	$(PY) tools/gen_wokwi.py --check

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

test:             ## every suite; fails if any service fails or has zero tests
	node tools/test_all.js

test-strict:      ## like test, but a missing PlatformIO CLI also fails
	node tools/test_all.js --strict

lint:
	npm run lint

format:
	npm run format

seed:
	npm run seed

demo:
	npm run demo
