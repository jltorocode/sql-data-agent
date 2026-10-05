-- Raw tables, with personal data. The agent never sees this schema.
CREATE SCHEMA store;

CREATE TABLE store.stores (
  store_id   int PRIMARY KEY,
  name       text NOT NULL,
  city       text NOT NULL,
  region     text NOT NULL,
  format     text NOT NULL CHECK (format IN ('mall', 'street', 'outlet', 'online')),
  opened_on  date NOT NULL
);

CREATE TABLE store.products (
  product_id   int PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  category     text NOT NULL,
  subcategory  text NOT NULL,
  brand        text NOT NULL,
  unit_cost    numeric(12, 0) NOT NULL,
  list_price   numeric(12, 0) NOT NULL
);

CREATE TABLE store.customers (
  customer_id   int PRIMARY KEY,
  full_name     text NOT NULL,
  email         text NOT NULL,
  phone         text NOT NULL,
  region        text NOT NULL,
  segment       text NOT NULL CHECK (segment IN ('regular', 'gold', 'platinum')),
  signed_up_on  date NOT NULL,
  birth_year    int NOT NULL
);

CREATE TABLE store.orders (
  order_id        int PRIMARY KEY,
  customer_id     int NOT NULL REFERENCES store.customers,
  store_id        int NOT NULL REFERENCES store.stores,
  ordered_at      timestamptz NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('store', 'web', 'app')),
  payment_method  text NOT NULL CHECK (payment_method IN ('credit_card', 'debit_card', 'cash', 'transfer')),
  status          text NOT NULL CHECK (status IN ('completed', 'cancelled', 'returned'))
);

CREATE TABLE store.order_items (
  order_id    int NOT NULL REFERENCES store.orders,
  line_no     int NOT NULL,
  product_id  int NOT NULL REFERENCES store.products,
  quantity    int NOT NULL CHECK (quantity > 0),
  unit_price  numeric(12, 0) NOT NULL,
  discount    numeric(4, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0 AND discount < 1),
  PRIMARY KEY (order_id, line_no)
);

CREATE INDEX ON store.orders (ordered_at);
CREATE INDEX ON store.orders (store_id);
CREATE INDEX ON store.orders (customer_id);
CREATE INDEX ON store.order_items (product_id);

-- What the agent can read: views without personal data, with business-friendly columns.
CREATE SCHEMA analytics;

CREATE VIEW analytics.stores AS
  SELECT store_id, name, city, region, format, opened_on FROM store.stores;

CREATE VIEW analytics.products AS
  SELECT product_id, sku, name, category, subcategory, brand, unit_cost, list_price FROM store.products;

CREATE VIEW analytics.customers AS
  SELECT customer_id, region, segment, signed_up_on, birth_year FROM store.customers;

CREATE VIEW analytics.orders AS
  SELECT order_id, customer_id, store_id, ordered_at,
         (ordered_at AT TIME ZONE 'America/Santiago')::date AS order_date,
         channel, payment_method, status
  FROM store.orders;

CREATE VIEW analytics.order_items AS
  SELECT order_id, line_no, product_id, quantity, unit_price, discount,
         round(quantity * unit_price * (1 - discount)) AS net_amount,
         quantity * p.unit_cost AS cost_amount
  FROM store.order_items
  JOIN store.products p USING (product_id);
