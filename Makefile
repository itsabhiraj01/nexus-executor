.PHONY: install build migrate dev test start pair docker-build docker-up docker-down clean

install:
	npm ci

build:
	npm run build

migrate:
	npm run migrate

dev:
	npm run dev

test:
	npm test

start:
	npm start

pair:
	npm run pair

docker-build:
	docker compose build

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

clean:
	rm -rf dist node_modules data
