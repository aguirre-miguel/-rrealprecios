#!/bin/sh
# Corre la prueba de sincronización segura con el motor JavaScript de macOS (sin instalar nada, sin red).
cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
OUT=$("$JSC" test/safe_sync_test.js 2>&1); echo "$OUT"
echo "$OUT" | grep -q 'RESULTADO: .* 0 fallas' || exit 1
