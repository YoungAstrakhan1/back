const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const pool = require('./db');
const cors = require('cors');

const app = express();
const PORT = 8000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({
  origin: 'http://localhost:8080',
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'username', 'password'],
  credentials: true
}));

const sessionStore = new MySQLStore({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'root',
    database: 'avoska'
});

app.use(session({
    key: 'session_cookie_name',
    secret: 'session_cookie_secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 // 1 день
    }
}));

// Регистрация пользователя
app.post('/register', async (req, res) => {
    const { full_name, phone, email, login, password } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO users (full_name, phone, email, login, password) VALUES (?, ?, ?, ?, ?)',
            [full_name, phone, email, login, password]
        );
        res.status(201).json({ id: result.insertId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Авторизация пользователя
app.post('/login', async (req, res) => {
    const { login, password } = req.body;
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE login = ?', [login]);
        const user = users[0];

        if (user && password === user.password) {
            req.session.userId = user.id;
            res.json({ message: 'Login successful' });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Просмотр всех заказов пользователя
app.get('/orders', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Сначала получаем заказы
        const [orders] = await pool.query(`
            SELECT id, delivery_address, status
            FROM orders
            WHERE user_id = ?
        `, [req.session.userId]);

        // Получаем элементы заказов для каждого заказа
        const orderItemsPromises = orders.map(async (order) => {
            const [items] = await pool.query(`
                SELECT products.name AS product_name, order_items.quantity
                FROM order_items
                JOIN products ON order_items.product_id = products.id
                WHERE order_items.order_id = ?
            `, [order.id]);
            return {
                ...order,
                items
            };
        });

        const ordersWithItems = await Promise.all(orderItemsPromises);

        res.json(ordersWithItems);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Создание нового заказа
app.post('/orders', async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { items, delivery_address } = req.body;

    console.log(req.body);

    let orderId;

    try {
      // Создаем запись в таблице orders
      const [orderResult] = await pool.query(
        'INSERT INTO orders (user_id, delivery_address) VALUES (?, ?)',
        [req.session.userId, delivery_address]
      );
      
      // Получаем ID созданного заказа
      orderId = orderResult.insertId;
      console.log(orderId);

      // Создаем записи в таблице order-items
      for (const item of items) {
        console.log(item);

        const { product_id, quantity } = item;
        await pool.query(
          'INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)',
          [orderId, product_id, quantity]
        );
      }

      res.status(201).json({ message: 'Order placed successfully' });
    } catch (err) {
      // В случае ошибки откатываем транзакцию и удаляем созданный заказ
      if (orderId) {
        await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);
      }
      res.status(400).json({ error: err.message });
    }
});

// Получение списка всех продуктов
app.get('/products', async (req, res) => {
    try {
        const [products] = await pool.query('SELECT * FROM products');
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера при получении списка продуктов' });
    }
});

// Вход администратора
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (username === 'sklad' && password === '123qwe') {
        req.session.userId = 'admin';
        res.status(200).json({ message: 'Успешная аутентификация' });
    } else {
        res.status(403).json({ error: 'Неверный логин или пароль' });
    }
});

// Получение всех заказов для администратора
app.get('/admin/orders', async (req, res) => {
    if (req.session.userId !== 'admin') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const query = `
            SELECT orders.id, users.full_name AS user_full_name, users.email AS user_email, 
                   products.name AS product_name, order_items.quantity, orders.delivery_address, orders.status
            FROM orders
            INNER JOIN users ON orders.user_id = users.id
            INNER JOIN order_items ON orders.id = order_items.order_id
            INNER JOIN products ON order_items.product_id = products.id
        `;
        const [orders] = await pool.query(query);
        const ordersWithItems = orders.reduce((acc, order) => {
            const existingOrder = acc.find(o => o.id === order.id);
            if (existingOrder) {
                existingOrder.items.push({ product_name: order.product_name, quantity: order.quantity });
            } else {
                acc.push({
                    id: order.id,
                    user_full_name: order.user_full_name,
                    user_email: order.user_email,
                    delivery_address: order.delivery_address,
                    status: order.status,
                    items: [{ product_name: order.product_name, quantity: order.quantity }]
                });
            }
            return acc;
        }, []);
        res.json(ordersWithItems);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Обновление статуса заказа администратором
app.put('/admin/orders/:orderId', async (req, res) => {
    if (req.session.userId !== 'admin') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { orderId } = req.params;
    const { status } = req.body;

    console.log(req.params)
    console.log(req.body)

    try {
        // Обновляем статус заказа в базе данных
        await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, orderId]);
        res.json({ message: 'Статус заказа обновлен' });
        console.log('Статус заказа обновлен')
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
