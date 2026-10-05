# Andes Market: analytics schema

Andes Market is a Chilean retail chain selling home, kitchen, small appliances, garden, sports, school and toy products. It has 23 physical stores across Chile and one online store. Amounts are in Chilean pesos (CLP), with no decimals.

The data covers orders from 2024-01-01 to 2026-09-30. Everything is in the schema `analytics`, which is the search path.

## stores
One row per store.
- store_id int, primary key
- name text, e.g. "Andes Costanera"
- city text
- region text: Chilean region, e.g. "Metropolitana", "Valparaíso", "Biobío"
- format text: 'mall', 'street', 'outlet' or 'online'. The single online store (store_id 24, "Andes Online") receives every web and app order.
- opened_on date. Three stores opened during the period: Antofagasta (2025-04-10), Iquique (2025-09-01) and Copiapó (2026-03-15).

## products
One row per product.
- product_id int, primary key
- sku text
- name text (in Spanish)
- category text: 'Hogar', 'Cocina', 'Electro', 'Jardín y Exterior', 'Deportes', 'Escolar y Oficina', 'Juguetes'
- subcategory text, e.g. 'Parrillas', 'Cafeteras', 'Mochilas'
- brand text
- unit_cost numeric: what the product costs Andes Market today
- list_price numeric: today's price. Past orders were sold at the prices of their time, in order_items.unit_price.

## customers
One row per customer. Personal data (names, emails, phones) is not available.
- customer_id int, primary key
- region text
- segment text: 'regular', 'gold' or 'platinum' (loyalty program)
- signed_up_on date
- birth_year int

## orders
One row per order.
- order_id int, primary key
- customer_id int, references customers
- store_id int, references stores
- ordered_at timestamptz
- order_date date: the order's date in Chile time. Use it for every date filter and grouping.
- channel text: 'store', 'web' or 'app'
- payment_method text: 'credit_card', 'debit_card', 'cash', 'transfer'
- status text: 'completed', 'cancelled' or 'returned'

## order_items
One row per order line.
- order_id int, references orders
- line_no int
- product_id int, references products
- quantity int
- unit_price numeric: price per unit at the time of the order, before discount
- discount numeric: fraction from 0 to 0.4 (0.2 means 20% off)
- net_amount numeric: quantity × unit_price × (1 − discount), rounded. This is what the customer paid for the line.
- cost_amount numeric: quantity × products.unit_cost

## Business definitions

Use these definitions unless the user asks for something else, and say which one you used.

- **Revenue** (ventas, ventas netas): sum of order_items.net_amount for orders with status 'completed'. Cancelled and returned orders are not revenue.
- **Orders**: count of distinct orders with status 'completed'.
- **Units**: sum of order_items.quantity for completed orders.
- **Average ticket** (ticket promedio, AOV): revenue divided by orders.
- **Gross margin** (margen bruto): revenue minus the sum of cost_amount, for completed orders. Margin % is gross margin divided by revenue.
- **Online**: channel 'web' or 'app'. **In-store**: channel 'store'.
- **Return rate**: units in returned orders divided by units in completed plus returned orders. Cancelled orders are left out.
- **Active customers** in a period: customers with at least one completed order in that period.
- **Year to date**: from January 1 to the last day with data (2026-09-30). When comparing a year to date with an earlier year, compare the same months (January to September).
- **Same-store growth**: compare only stores that were open during the whole of both periods.

## Seasons in Chile

- CyberDay: the first days of June. Black Friday: late November. Christmas: December.
- Fiestas Patrias (national holidays): September 18. Grills and charcoal sell the most the week before.
- Back to school: February and March.
- Día del Niño (children's day): August.
- Summer is December to February; winter is June to August.
