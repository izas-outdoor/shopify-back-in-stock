require('dotenv').config();
require('@shopify/shopify-api/adapters/node');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const path = require('path');

const app = express();

// =====================================================================
// 1. CONFIGURACIÓN BÁSICA DEL SERVIDOR
// =====================================================================
// ¡IMPORTANTE! Para los webhooks necesitamos el cuerpo en crudo (raw),
// pero para nuestra API necesitamos JSON. Lo manejaremos más abajo.
app.use(cors());
app.use(cookieParser());
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SHOPIFY_API_SECRET || 'super-secreto-temporal',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: true, sameSite: 'none' } // Necesario para iframes
}));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// =====================================================================
// 2. CONFIGURACIÓN DE SHOPIFY (La "Llave" para entrar al panel)
// =====================================================================
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products'], // Permisos mínimos que necesitamos
  hostName: process.env.HOST.replace(/https:\/\//, ''), // Render URL sin https://
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: true,
});

// Ruta principal: Shopify entra por aquí cada vez que abres la app
app.get('/shopify', (req, res) => {
  const shop = req.query.shop;
  const host = req.query.host;

  if (!shop || !host) {
    return res.status(400).send('Falta el parámetro shop o host.');
  }

  // Como la app ya está instalada, pasamos de largo el OAuth
  // y redirigimos directamente a nuestra interfaz gráfica
  res.redirect(`/?shop=${shop}&host=${host}`);
});

// Ruta de instalación de emergencia (solo por si algún día necesitas reinstalarla)
app.get('/install', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Falta el parámetro shop.');
  
  await shopify.auth.begin({
    shop: shop,
    callbackPath: '/auth/callback',
    isOnline: false,
    rawRequest: req,
    rawResponse: res,
  });
});

// Ruta de retorno: Shopify nos devuelve aquí después de autorizar
app.get('/auth/callback', async (req, res) => {
  try {
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const session = callbackResponse.session;
    // (Opcional) Aquí guardarías la 'session' en tu base de datos si fueras a usar la API de Shopify activamente

    // Si todo va bien, redirigimos a la interfaz de nuestra app (el panel de control)
    // El App Bridge necesita el parámetro 'host' para saber que está dentro de Shopify
    const host = req.query.host;
    res.redirect(`/?shop=${session.shop}&host=${host}`);
  } catch (error) {
    console.error('Error en el callback de OAuth:', error);
    res.status(500).send('Error durante la autenticación con Shopify.');
  }
});

// Nuestra interfaz gráfica (el archivo HTML que creaste)
app.get('/', (req, res) => {
  // Verificación básica de que vienen de Shopify
  if (!req.query.shop || !req.query.host) {
    return res.status(401).send('Acceso denegado. Esta app solo funciona dentro del administrador de Shopify.');
  }
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// =====================================================================
// 3. LOS ENDPOINTS ANTIGUOS (Suscripción y Webhook)
// =====================================================================

// Middleware para parsear JSON en las rutas que no sean webhooks
app.use((req, res, next) => {
  if (req.path === '/webhook/products-update') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Suscripción desde la tienda
app.post('/subscribe', async (req, res) => {
  // 1. Añadimos variant_title a los datos extraídos
  const { email, variant_id, product_title, image_url, variant_title } = req.body;

  if (!email || !variant_id) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // 2. Lo incluimos en la inserción de Supabase
  const { error } = await supabase
    .from('back_in_stock_requests')
    .insert([{ email, variant_id, product_title, image_url, variant_title }]);

  if (error) {
    console.error('Error al guardar:', error);
    return res.status(500).json({ error: 'Error interno' });
  }

  res.status(200).json({ success: true });
});

// Webhook de Shopify (OJO: Shopify envía raw body, por eso usamos express.raw aquí)
app.post('/webhook/products-update', express.raw({type: 'application/json'}), async (req, res) => {
  res.status(200).send('OK');

  try {
    const product = JSON.parse(req.body.toString());
    if (!product || !product.variants) return;

    for (const variant of product.variants) {
      if (variant.inventory_quantity > 0) {
        
        const { data: requests, error: fetchError } = await supabase
          .from('back_in_stock_requests')
          .select('*')
          .eq('variant_id', variant.id)
          .eq('notified', false);

        if (fetchError || !requests || requests.length === 0) continue;

        let imageUrl = '';
        if (variant.image_id && product.images) {
          const variantImage = product.images.find(img => img.id === variant.image_id);
          if (variantImage) imageUrl = variantImage.src;
        }
        if (!imageUrl && product.image) imageUrl = product.image.src;
        if (!imageUrl) imageUrl = 'https://cdn.shopify.com/s/images/admin/no-image-large.gif'; 

        for (const request of requests) {
          await resend.emails.send({
            from: 'Izas Outdoor <avisos@izas-outdoor.com>',
            to: request.email,
            subject: `¡Ya está disponible: ${request.product_title}!`,
            html: `
              <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e4e4e4; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #000000; padding: 20px; text-align: center;">
                  <img src="https://izas-outdoor.com/cdn/shop/files/Logo_Izas_Blanco.png" alt="Izas Outdoor" style="max-height: 40px;">
                </div>
                <div style="padding: 40px 30px; text-align: center;">
                  <h2 style="color: #333333; margin-top: 0; font-size: 24px;">¡Buenas noticias!</h2>
                  <p style="color: #666666; font-size: 16px; line-height: 1.5;">El artículo que estabas esperando acaba de volver a nuestro almacén. No lo dejes escapar, ¡el stock vuela!</p>
                  <div style="margin: 30px 0; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
                    <img src="${imageUrl}" alt="${request.product_title}" style="max-width: 200px; border-radius: 4px; margin-bottom: 15px; object-fit: cover;">
                    <h3 style="color: #333333; margin: 0 0 5px 0; font-size: 18px;">${request.product_title}</h3>
                    <p style="color: #888888; margin: 0; font-size: 14px;">Variante: <strong style="color: #000;">${variant.title}</strong></p>
                  </div>
                  <a href="https://izas-outdoor.com/products/${product.handle}?variant=${variant.id}" style="display: inline-block; background-color: #000000; color: #ffffff; text-decoration: none; padding: 15px 30px; font-size: 16px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Comprar Ahora</a>
                </div>
              </div>
            `
          });

          await supabase.from('back_in_stock_requests').update({ notified: true }).eq('id', request.id);
        }
      }
    }
  } catch (error) {
    console.error("Error procesando webhook:", error);
  }
});

// Endpoint interno para enviar los datos al Dashboard de forma segura
app.get('/api/analytics', async (req, res) => {
  // Tu servidor (que tiene las claves secretas) hace la petición a Supabase
  const { data, error } = await supabase
    .from('back_in_stock_requests')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  // Devuelve los datos limpios al frontend
  res.json(data);
});

// =====================================================================
// 4. INICIO DEL SERVIDOR
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
