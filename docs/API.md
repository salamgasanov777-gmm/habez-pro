# API

Полная спецификация — `GET /api/openapi.json` (открывается в Swagger UI или
Postman). Ниже — то, что нужно знать, чтобы подключить к системе новый клиент:
телеграм-бот, обмен с 1С, мобильное приложение.

## Основы

- Базовый адрес: `https://<домен>/api`
- Формат — JSON. Ошибка всегда одинаковой формы:
  ```json
  { "error": { "code": "validation_error", "message": "Проверьте заполнение полей",
               "fields": [{ "path": "customer.phone", "message": "Too small" }] } }
  ```
- Компания определяется по домену. Если клиент ходит не по домену компании —
  заголовок `x-tenant: habez`.
- Авторизация: `Authorization: Bearer <access-токен>`. Токен живёт 15 минут,
  обновляется через `POST /api/auth/refresh` (нужна cookie сессии).

## Что можно сделать без входа

```
GET  /api/catalog/meta                    разделы, задачи, настройки витрины
GET  /api/catalog/products?search=&category=&task=&sort=&page=
GET  /api/catalog/products/{id|slug}      карточка целиком
GET  /api/catalog/compare?ids=1,2,3       сводная таблица сравнения
POST /api/catalog/calc                    расчёт расхода
POST /api/leads                           заявка: цена, дилерство, звонок
GET  /api/cart · POST /api/cart/items     корзина (по cookie)
POST /api/orders                          оформление заказа
GET  /api/orders/{номер}?phone=9381234567 свой заказ по номеру и телефону
```

## Пример: заказ от начала до конца

```bash
# 1. Найти товар
curl -G https://catalog.habez.ru/api/catalog/products --data-urlencode "search=аквалайт"

# 2. Положить фасовку в корзину (cookie сохраняем)
curl -c jar -X POST https://catalog.habez.ru/api/cart/items \
  -H 'content-type: application/json' -d '{"variantId":1,"qty":4}'

# 3. Оформить
curl -b jar -X POST https://catalog.habez.ru/api/orders \
  -H 'content-type: application/json' \
  -d '{"customer":{"name":"Ахмед","phone":"+79381234567","deliveryType":"pickup"}}'

# 4. Получить ссылку на оплату
curl -X POST https://catalog.habez.ru/api/payments/create \
  -H 'content-type: application/json' -d '{"orderNumber":"ХГЗ-2609-0001"}'
```

## Панель (роль не ниже менеджера)

```
GET   /api/admin/stats                     сводка
GET   /api/admin/products                  список с поиском
POST  /api/admin/products                  создать
PUT   /api/admin/products/{id}             изменить
PUT   /api/admin/variants/{id}/price       цена: {tier, amount, minQty}
PUT   /api/admin/variants/{id}/stock       остаток
POST  /api/admin/prices/bulk               массовое изменение процентом
GET   /api/admin/orders · PATCH /api/admin/orders/{id}
GET   /api/admin/leads   · PATCH /api/admin/leads/{id}
GET   /api/admin/users   · PATCH /api/admin/users/{id}
GET   /api/admin/export/prices.csv         прайс для Excel
GET   /api/admin/audit                     журнал изменений
```

Цена `amount` — в копейках. `null` означает «цена по запросу», а не ноль:
покупатель увидит кнопку «Запросить цену» вместо «В корзину».

## Обмен с 1С

Отдельного маршрута нет намеренно: формат выгрузки у каждого завода свой,
и его должен дать их IT-отдел. Когда формат известен, обмен пишется как
скрипт, который раз в час читает выгрузку и вызывает `PUT /api/admin/variants/{id}/price`
и `/stock` под учётной записью робота с ролью `manager`. Ломать ради этого
модель данных не нужно — всё, что требуется, уже есть в API.
