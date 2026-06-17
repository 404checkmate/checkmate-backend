#!/usr/bin/env bash
# Checkmate 원격 배포 스크립트 (EC2에서 직접 실행)
# GitHub Actions 가 rsync 로 아티팩트를 _incoming/ 에 전송한 후 호출.
# 사용 예: bash deploy.sh --backend=true --frontend=false
set -euo pipefail

APP_DIR="/home/ubuntu/checkmate"
WEB_ROOT="/var/www/checkmate"
RELEASES_DIR="/var/www/checkmate-releases"
BACKEND_SRC="${APP_DIR}/_incoming/backend"
BACKEND_DST="${APP_DIR}/checkmate-backend"
FRONTEND_SRC="${APP_DIR}/_incoming/frontend"

DEPLOY_BACKEND="false"
DEPLOY_FRONTEND="false"

# ── 플래그 파싱 ───────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --backend=*)  DEPLOY_BACKEND="${arg#*=}" ;;
    --frontend=*) DEPLOY_FRONTEND="${arg#*=}" ;;
  esac
done

echo "[deploy] $(date '+%Y-%m-%d %H:%M:%S') backend=${DEPLOY_BACKEND} frontend=${DEPLOY_FRONTEND}"

if [[ "${DEPLOY_BACKEND}" != "true" && "${DEPLOY_FRONTEND}" != "true" ]]; then
  echo "[deploy] 배포할 대상이 없습니다. --backend=true 또는 --frontend=true 를 전달하세요."
  exit 1
fi

# ── 백엔드 배포 ───────────────────────────────────────────────
if [[ "${DEPLOY_BACKEND}" == "true" ]]; then
  echo "[deploy] Backend: 시작"

  if [[ ! -d "${BACKEND_SRC}" ]]; then
    echo "[deploy] ERROR: ${BACKEND_SRC} 가 없습니다. rsync 가 먼저 실행되어야 합니다."
    exit 1
  fi

  cd "${BACKEND_SRC}"

  # EC2 에만 존재하는 .env 를 dist 옆에서 참조할 수 있도록 심볼릭 링크
  ln -sf "${BACKEND_DST}/.env" "${BACKEND_SRC}/.env"

  # 프로덕션 의존성 설치
  npm ci --omit=dev --no-audit --no-fund

  # EC2 OS 전용 Prisma 네이티브 바이너리 재생성
  npx prisma generate

  # DB 마이그레이션 (롤백 없는 프로덕션 전용 명령)
  npx prisma migrate deploy

  # 기존 dist 백업 후 원자적 교체
  if [[ -d "${BACKEND_DST}/dist" ]]; then
    rm -rf "${BACKEND_DST}/dist.prev"
    mv "${BACKEND_DST}/dist" "${BACKEND_DST}/dist.prev"
  fi
  cp -r "${BACKEND_SRC}/dist"         "${BACKEND_DST}/dist"

  # node_modules 도 원자적 교체 — 기존 디렉터리가 있으면 `cp -r` 가 그 안에
  # 중첩(node_modules/node_modules)되어 구 @prisma/client 가 남는 버그 방지.
  # (dist 만 갱신되고 Prisma Client 가 옛 스키마로 고착되는 원인)
  if [[ -d "${BACKEND_DST}/node_modules" ]]; then
    rm -rf "${BACKEND_DST}/node_modules.prev"
    mv "${BACKEND_DST}/node_modules" "${BACKEND_DST}/node_modules.prev"
  fi
  cp -r "${BACKEND_SRC}/node_modules" "${BACKEND_DST}/node_modules"
  cp    "${BACKEND_SRC}/package.json" "${BACKEND_DST}/package.json"

  # PM2 무중단 reload (미등록 시 최초 start)
  if pm2 describe checkmate-api >/dev/null 2>&1; then
    pm2 reload checkmate-api --update-env
  else
    pm2 start "${APP_DIR}/deploy/pm2/ecosystem.config.cjs"
    pm2 save
  fi

  echo "[deploy] Backend: 완료"
fi

# ── 프론트 배포 ───────────────────────────────────────────────
if [[ "${DEPLOY_FRONTEND}" == "true" ]]; then
  echo "[deploy] Frontend: 시작"

  if [[ ! -d "${FRONTEND_SRC}" ]]; then
    echo "[deploy] ERROR: ${FRONTEND_SRC} 가 없습니다. rsync 가 먼저 실행되어야 합니다."
    exit 1
  fi

  # 릴리즈 디렉토리에 정적 파일 배포
  RELEASE_DIR="${RELEASES_DIR}/$(date +%Y%m%d-%H%M%S)"
  sudo mkdir -p "${RELEASE_DIR}"
  sudo cp -r "${FRONTEND_SRC}/." "${RELEASE_DIR}/"

  # 심볼릭 링크 원자적 스왑 (ln -sfn 은 atomic 에 가까움)
  sudo ln -sfn "${RELEASE_DIR}" "${WEB_ROOT}"

  # 최근 5개만 보존, 나머지 정리
  sudo find "${RELEASES_DIR}" -maxdepth 1 -mindepth 1 -type d \
    | sort -r | tail -n +6 | xargs -r sudo rm -rf

  # Nginx 설정 문법 확인 (재로드는 불필요 — 심볼릭 링크만 갈아끼움)
  sudo nginx -t

  echo "[deploy] Frontend: 완료"
fi

# ── 임시 아티팩트 정리 ────────────────────────────────────────
rm -rf "${BACKEND_SRC}" "${FRONTEND_SRC}" 2>/dev/null || true

echo "[deploy] ✅ 전체 완료 — $(date '+%Y-%m-%d %H:%M:%S')"
