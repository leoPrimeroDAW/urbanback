const express = require('express');
const mysql = require('mysql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
const secretKey = 'your_secret_key'; // Cambia esto por una clave secreta fuerte

app.use(cors());
app.use(express.json());

// Verificar y crear el directorio `tickets` si no existe
const ticketsDir = path.join(__dirname, 'tickets');
if (!fs.existsSync(ticketsDir)) {
  fs.mkdirSync(ticketsDir);
}

// Conexión a la base de datos
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'burger'
});

db.connect((error) => {
  if (error) {
    console.error('Error connecting: ' + error.stack);
    return;
  }
  console.log('Connected as id ' + db.threadId);
});

// Middleware para proteger rutas
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).send('Access Denied');
  }

  jwt.verify(token, secretKey, (err, user) => {
    if (err) {
      return res.status(403).send('Invalid Token');
    }
    req.user = user;
    next();
  });
};

app.post('/register', async (req, res) => {
  const { username, password, email, firstName, lastName } = req.body;
  if (!username || !password || !email || !firstName || !lastName) {
    return res.status(400).send('All fields are required');
  }
  const hashedPassword = await bcrypt.hash(password, 10);

  const query = 'INSERT INTO Usuarios (username, password, email, nombre, apellido) VALUES (?, ?, ?, ?, ?)';
  db.query(query, [username, hashedPassword, email, firstName, lastName], (error, results) => {
    if (error) {
      console.error('Error registering user:', error);
      return res.status(500).send('Error registering user');
    }
    res.status(201).send('User registered successfully');
  });
});

// Login de usuario
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  const query = 'SELECT * FROM Usuarios WHERE username = ?';
  db.query(query, [username], async (error, results) => {
    if (error) {
      return res.status(500).send('Error logging in');
    }

    if (results.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = results[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(400).send('Invalid password');
    }

    const token = jwt.sign({ id: user.id, username: user.username }, secretKey, { expiresIn: '1h' });
    res.json({ token });
  });
});

// Ruta para obtener la página de inicio con el formulario de introducción del número de mesa
app.get('/', (req, res) => {
  res.send(`
    <h1>Bienvenido a nuestro restaurante</h1>
    <form action="/pedido" method="post">
      <label for="mesa_id">Número de mesa:</label>
      <input type="number" id="mesa_id" name="mesa_id" required>
      <button type="submit">Ingresar</button>
    </form>
  `);
});

// Ruta para obtener la carta del restaurante
app.get('/carta', (req, res) => {
  const query = `
    SELECT Productos.*, Categorias.nombre AS categoria
    FROM Productos
    LEFT JOIN Categorias ON Productos.categoria_id = Categorias.categoria_id
  `;
  db.query(query, (error, results) => {
    if (error) throw error;
    res.json(results);
  });
});

// Ruta para realizar un pedido
app.post('/pedido', (req, res) => {
  const { mesa_id, user_name, productos } = req.body;

  db.beginTransaction((error) => {
    if (error) throw error;

    const query = 'INSERT INTO Pedidos (fecha_pedido, total, estado, mesa_id, user_name) VALUES (CURRENT_TIMESTAMP, 0, "aceptado", ?, ?)';
    db.query(query, [mesa_id, user_name], (error, results) => {
      if (error) {
        return db.rollback(() => {
          throw error;
        });
      }

      const pedidoId = results.insertId;

      productos.forEach((producto) => {
        // Convertir los ingredientes a una cadena de texto antes de guardarlos en la base de datos
        const ingredientesString = JSON.stringify(producto.ingredientes);
        const query = 'INSERT INTO DetallesPedidos (pedido_id, producto_id, cantidad, precio_unitario, ingredientes) VALUES (?, ?, ?, (SELECT precio FROM Productos WHERE producto_id = ?), ?)';
        db.query(query, [pedidoId, producto.producto_id, producto.cantidad, producto.producto_id, ingredientesString], (error, results) => {
          if (error) {
            return db.rollback(() => {
              throw error;
            });
          }
        });
      });

      db.commit((error) => {
        if (error) {
          return db.rollback(() => {
            throw error;
          });
        }
        res.status(201).send('Pedido creado con éxito');
      });
    });
  });
});

// Ruta para obtener el detalle de un producto por su ID en Cliente
app.get('/pedidos/producto/:id', (req, res) => {
  const productId = req.params.id;
  const query = `
  SELECT 
    P.*,
    GROUP_CONCAT(A.nombre) AS alergenos
  FROM 
    Productos AS P
  LEFT JOIN 
    ProductosAlergenos AS PA ON P.producto_id = PA.producto_id
  LEFT JOIN 
    Alergenos AS A ON PA.alergeno_id = A.alergeno_id
  WHERE 
    P.producto_id = ?
  GROUP BY 
    P.producto_id;
  `;
  db.query(query, [productId], (error, results) => {
    if (error) {
      return res.status(500).json({ error: 'Error al obtener el detalle del producto' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const producto = results[0];
    res.json(producto);
  });
});

app.get('/admin/pedidos', authenticateToken, (req, res) => {
  const query = `
    SELECT 
      Pedidos.pedido_ID,
      Pedidos.fecha_pedido,
      Pedidos.estado,
      Pedidos.user_name,
      Mesas.num_mesa AS numero_mesa,
      SUM(DetallesPedidos.cantidad * DetallesPedidos.precio_unitario) AS total,
      (
        SELECT 
          GROUP_CONCAT(
            JSON_OBJECT(
              'producto_id', dp.producto_id,
              'nombre', p.nombre,
              'cantidad', dp.cantidad,
              'precio_unitario', dp.precio_unitario,
              'ingredientes', dp.ingredientes
            )
            SEPARATOR ','
          )
        FROM 
          DetallesPedidos dp
        LEFT JOIN 
          Productos p ON dp.producto_id = p.producto_id
        WHERE 
          dp.pedido_id = Pedidos.pedido_ID
      ) AS detalles
    FROM 
      Pedidos
    LEFT JOIN 
      Mesas ON Pedidos.mesa_id = Mesas.mesa_id
    LEFT JOIN 
      DetallesPedidos ON Pedidos.pedido_ID = DetallesPedidos.pedido_id
    GROUP BY 
      Pedidos.pedido_ID
    ORDER BY Pedidos.fecha_pedido DESC
  `;
  db.query(query, (error, results) => {
    if (error) throw error;
    res.json(results);
  });
});

// Ruta para generar el ticket en PDF
app.get('/admin/pedidos/:id/ticket', authenticateToken, (req, res) => {
  const pedidoId = req.params.id;

  const queryPedido = `
    SELECT 
      Pedidos.pedido_ID,
      Pedidos.fecha_pedido,
      SUM(DetallesPedidos.cantidad * DetallesPedidos.precio_unitario) AS total,
      Mesas.num_mesa AS numero_mesa,
      Pedidos.user_name,
      GROUP_CONCAT(
        JSON_OBJECT(
          'nombre', Productos.nombre,
          'cantidad', DetallesPedidos.cantidad,
          'precio_unitario', DetallesPedidos.precio_unitario
        )
        SEPARATOR ','
      ) AS detalles
    FROM 
      Pedidos
    LEFT JOIN 
      Mesas ON Pedidos.mesa_id = Mesas.mesa_id
    LEFT JOIN 
      DetallesPedidos ON Pedidos.pedido_ID = DetallesPedidos.pedido_id
    LEFT JOIN 
      Productos ON DetallesPedidos.producto_id = Productos.producto_id
    WHERE 
      Pedidos.pedido_ID = ?
    GROUP BY 
      Pedidos.pedido_ID
  `;

  db.query(queryPedido, [pedidoId], (error, results) => {
    if (error) {
      console.error('Error fetching pedido:', error);
      return res.status(500).send('Error fetching pedido');
    }

    if (results.length === 0) {
      return res.status(404).send('Pedido no encontrado');
    }

    const pedido = results[0];
    const detalles = JSON.parse(`[${pedido.detalles}]`);

    // Formatear la fecha al formato español
    const fechaPedido = new Date(pedido.fecha_pedido);
    const fechaFormateada = fechaPedido.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }) + ' ' + fechaPedido.toLocaleTimeString('es-ES');

    // Crear el documento PDF
    const doc = new PDFDocument();
    const filePath = path.join(__dirname, 'tickets', `ticket_${pedidoId}.pdf`);

    // Configurar el stream de escritura
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Escribir en el PDF
    doc.fontSize(20).text('Ticket de Pedido', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Número de Pedido: ${pedido.pedido_ID}`);
    doc.text(`Fecha: ${fechaFormateada}`);
    doc.text(`Mesa: ${pedido.numero_mesa}`);
    doc.text(`Cliente: ${pedido.user_name}`);
    doc.moveDown();

    doc.fontSize(16).text('Detalles del Pedido:');
    detalles.forEach(detalle => {
      doc.text(`${detalle.cantidad} x ${detalle.nombre} - ${detalle.precio_unitario.toFixed(2)}€`);
    });

    doc.moveDown();
    doc.fontSize(14).text(`Total: ${pedido.total.toFixed(2)}€`, { align: 'right' });

    // Finalizar el documento
    doc.end();

    stream.on('finish', () => {
      res.sendFile(filePath);
    });
  });
});

// Ruta para obtener los detalles de un pedido específico
app.get('/admin/pedidos/:id/detalles', authenticateToken, (req, res) => {
  const { id } = req.params;

  const query = 'SELECT * FROM DetallesPedidos WHERE pedido_id = ?';
  db.query(query, [id], (error, results) => {
    if (error) {
      return res.status(500).send('Error al obtener los detalles del pedido');
    }
    res.json(results);
  });
});

app.put('/admin/pedidos/:id', authenticateToken, (req, res) => {
  const { id } = req.params;

  const query = 'UPDATE Pedidos SET estado = "listo" WHERE pedido_id = ?';
  db.query(query, [id], (error, results) => {
    if (error) {
      return res.status(500).send('Error al actualizar el pedido');
    }
    if (results.affectedRows === 0) {
      return res.status(404).send('Pedido no encontrado');
    }
    res.status(200).send('Pedido actualizado a "listo" con éxito');
  });
});

// Ruta para servir los archivos PDF
app.use('/tickets', express.static(path.join(__dirname, 'tickets')))

// Manejador de errores 404
app.use((req, res, next) => {
  res.status(404).send('Error 404: Recurso no encontrado');
});

// Iniciar el servidor
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Servidor corriendo en http://localhost:${port}`));
