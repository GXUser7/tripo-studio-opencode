---
name: Tripo Studio
description: Генерация, доработка, риггинг, анимация и экспорт 3D-моделей и изображений через аккаунт Tripo Studio пользователя без API-ключа. Используй также для работы с существующими активами Studio, группировки моделей/картинок, локальных правок в Blender. Generate, edit, rig, animate and export 3D models / images with the user's Tripo Studio account (no API key).
---

# Tripo Studio в OpenCode

Это адаптация плагина `GrinZero/tripo-studio-plugin` (v0.3.13) для OpenCode. MCP-сервер подключён как `tripo`.

## Имена инструментов

OpenCode переименовывает MCP-инструменты в `<server>_<tool>`, поэтому в этой сборке они выглядят так:

- под Code Mode (по умолчанию): `tools.tripo.tripo_generate_model(...)`
- как обычные tool-имена: `tripo_tripo_generate_model`

В тексте ниже инструменты названы по исходным именам плагина (`tripo_generate_model`) — при вызове добавляй префикс `tripo_`.

## Главное ограничение хоста: нет UI-карточки

В Codex плагин рисует интерактивную карточку конфигурации. В OpenCode её нет, поэтому:

- **никогда** не вызывай `tripo_ui_preview`, `tripo_ui_import_image`, `tripo_ui_asset_library`, `tripo_ui_review`, `tripo_submit_task`, `tripo_run_workflow`, `tripo_open_workbench` — это app-only инструменты, работающие только внутри UI Codex;
- любой создающий/меняющий инструмент (`tripo_generate_model`, `tripo_generate_texture`, `tripo_rig_model`, …) **создаёт форму с серверным дедлайном 60 секунд и сама отправляет задачу** — даже если карточка не показана. То есть вызов = реальная трата кредитов Studio, а не безобидный предпросмотр;
- поэтому **сначала согласуй с пользователем операцию, параметры и оценку стоимости**, и только потом вызывай создающий инструмент;
- после вызова жди результат через `tripo_get_configuration_review` с `wait_ms: 60000`, повторяя на том же `review_id`, пока не появится `task_id`; затем `tripo_task_wait` / `tripo_task_sync`. Не создавай дубликат задачи.

Пользователь не может отредактировать карточку в OpenCode — параметры, переданные в вызове, и есть финальные. Если нужны другие настройки, задавай их сразу в аргументах.

## Авторизация

1. Перед любой удалённой работой — `tripo_auth_status`.
2. Если сессии нет — объясни пользователю ручной вход и после его согласия вызови `tripo_auth_login` без `headless_only`. Windows-адаптер открывает отдельное окно Microsoft Edge на официальном `https://studio.tripo3d.ai/`, используя только профиль интеграции `%LOCALAPPDATA%/TripoStudioPlugin/opencode-browser`. Пользователь входит сам; ожидание — до 10 минут. Закрытие окна или отмена вызова прекращает вход. Окно закрывается и после успешной проверки сессии.
3. Адаптер получает только `ory_kratos_session` ожидаемых доменов Tripo из этого отдельного Playwright-контекста и передаёт его upstream `tripo_auth_import` внутри процесса обмена MCP, без вывода в чат/логи. **Никогда не проси cookie, токен, пароль или код входа в чате; не вызывай `tripo_auth_import` вручную.** Не читай базы cookie существующих браузеров и не обходи защиту Windows/Chromium. Автоматическое сканирование браузерных хранилищ upstream отключено; при истечении сессии нужен новый явный `tripo_auth_login`.
4. Сессия адаптера хранится отдельно: `%LOCALAPPDATA%/TripoStudioPlugin/opencode-session`; прежние данные не перезаписываются. `tripo_auth_logout` удаляет сохранённую сессию плагина, но не выполняет выход из отдельного браузерного профиля. Повторный явный login может использовать уже выполненный вход в этом профиле.
5. Локальные инструменты (Blender, inspect, crop) логина не требуют. Авторизация не запускает генерацию и не тратит кредиты.

## Перед платной операцией

- `tripo_get_payment` — баланс и план (read-only).
- `tripo_quote_operation` — оценка стоимости по `kind` + `input`, либо по `task_id` для уже зафиксированных параметров. `estimated_credits: null` = неизвестно, не «бесплатно».
- `tripo_list_operations` — каталог операций и флаг `consumes_credits` (схем параметров там нет, бери их из определения инструмента).
- Скажи пользователю модель/версию, оценку и то, что отправка произойдёт автоматически через 60 с, и дождись явного согласия на трату кредитов.

## Выбор операции

- **Картинки**: `tripo_generate_image` (до 10 референсов, `studio_references: [{asset_id, output_index}]` для правки существующего результата), `tripo_generate_multiview`, `tripo_regenerate_image`, `tripo_upscale_image`, `tripo_split_image`, `tripo_crop_image` (локально).
- **3D**: `tripo_generate_model` (`tier: smart_mesh | high_detail`; `mode: batch` — до 30 независимых изображений, это не multiview-фьюжн).
- **Smart Mesh = три отдельные стадии**: белый меш (`tripo_generate_model`, без texture/pbr) → цветные текстуры (`tripo_generate_texture`) → PBR-карты (`tripo_generate_pbr`). Каждая стадия — отдельная задача и отдельные кредиты; жди успеха предыдущей, используй `project_id` и `parent_task_id`.
- **Доработка модели**: `tripo_import_model`, `tripo_segment_model`, `tripo_complete_parts`, `tripo_remesh_model`, `tripo_generate_texture`, `tripo_preview_texture_edit` / `tripo_apply_texture_edits` (Magic Brush), `tripo_upscale_texture`, `tripo_generate_pbr`.
- **Smart UV**: `tripo_get_uv_context` → `tripo_generate_uv` → проверка кандидата → `tripo_apply_uv`.
- **Риггинг**: `tripo_rig_model` (V3 по умолчанию; скелеты actorcore/mixamo/unreal/vrm/unity, `rigging_type: other` для животных). Анимация: `tripo_list_animation_presets` + `tripo_animate_model`, либо `tripo_generate_motion` (1–5 сегментов по 1–10 с) + `tripo_apply_motion`.
- **Экспорт**: `tripo_export_model` (GLB/FBX/OBJ/USDZ/STL/3MF, только свои проекты) и **обязательно** затем `tripo_download` по `task_id` задачи экспорта — формат задаётся в экспорте, `tripo_download` его не конвертирует.

## Качество текстур

`standard` = 2K, `detailed` = 4K, `ultra` = 8K (внутри Studio это `extreme`). После генерации/апскейла/PBR проверяй `task.result.texture_resolution`: `status: succeeded` относится только к удалённому выполнению. Про 8K можно говорить только при `actual_texture_size_verified: true` и `requested_texture_size_met: true`.

## Локальные правки (Blender, 0 кредитов)

Цепочка: `tripo_inspect_local_parts` → `tripo_edit_parts` → `tripo_render_model` → (`tripo_preview_texture_edit` или локальная правка) → `tripo_bake_texture_projection` → `tripo_apply_texture_edits`. Нужен Blender в PATH или `TRIPO_BLENDER_EXECUTABLE`, вход — самодостаточный GLB (Meshopt декодируется автоматически).

## Группы активов

Пять публичных инструментов: `tripo_list_asset_groups`, `tripo_list_group_assets`, `tripo_create_asset_group`, `tripo_set_asset_group`, `tripo_rename_asset_group` (членство задаётся как `{project_id}` для модели и `{asset_id}` для картинки, до 500 за вызов, кредитов не тратит). Детали: [references/asset-groups.md](references/asset-groups.md).

## Идентичность персонажа

Для персонажной работы передавай `character_name` в каждом создающем вызове (например `派蒙`, а не название операции). Продолжение работы — через `parent_task_id`. Исправить группу у существующей задачи — `tripo_set_task_character`.

## Завершение и отчёт

- `tripo_task_wait` → `tripo_download` → отдай реальные локальные пути файлов.
- Прерванные/неизвестные (`outcome_unknown`) задачи не переотправляй: сначала `tripo_task_reconcile`.
- `tripo_show_result`, `tripo_open_in_studio` возвращают данные/ссылку; в OpenCode превью-панели нет, поэтому показывай пути и URL текстом.

Полный оригинальный текст инструкции плагина (Codex-версия) — [references/upstream-codex-skill.md](references/upstream-codex-skill.md). При расхождении приоритет у этого файла: ограничения UI описаны выше.
