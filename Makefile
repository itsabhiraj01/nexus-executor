.PHONY: install update db-backup deps build migrate dev test test-install start pair repair docker-build docker-up docker-down clean

install:
	bash ./install.sh $(ARGS)

update:
	bash ./install.sh $(ARGS)

db-backup:
	node scripts/database.mjs backup

deps:
	npm ci

build:
	npm run build

migrate:
	npm run migrate

dev:
	npm run dev

test:
	npm test

test-install:
	node --test scripts/*.test.mjs

start:
	npm start

pair:
	npm run pair

repair:
	npm run repair

docker-build:
	docker compose build

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

clean:
	rm -rf dist node_modules data
