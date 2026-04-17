require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();

// Permite recibir datos en formato JSON y peticiones desde tu tienda
app.use(express.json());
app.use(cors()); 

// Inicializar conexiones
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// =====================================================================
// ENDPOINT 1: Recibe la petición desde la tienda y la guarda en Supabase
// =====================================================================
app.post('/subscribe', async (req, res) => {
  const { email, variant_id, product_title } = req.body;

  // Validación básica
  if (!email || !variant_id) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  // Guardar en Supabase
  const { error } = await supabase
    .from('back_in_stock_requests')
    .insert([{ email, variant_id, product_title }]);

  if (error) {
    console.error('Error guardando en BD:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  console.log(`[+] Nuevo aviso guardado: ${email} para la variante ${variant_id}`);
  res.status(200).json({ success: true, message: 'Guardado correctamente' });
});

// =====================================================================
// ENDPOINT 2: El Webhook de Shopify (Avisa cuando hay cambios en productos)
// =====================================================================
app.post('/webhook/products-update', async (req, res) => {
  // Shopify requiere que respondamos con un 200 OK rápido para saber que recibimos el aviso
  res.status(200).send('Webhook recibido');

  const product = req.body;
  
  // Si no hay variantes en la respuesta, no hacemos nada
  if (!product || !product.variants) return;

  // Recorremos todas las variantes del producto que se acaba de actualizar
  for (const variant of product.variants) {
    
    // Si la variante tiene stock positivo (> 0)
    if (variant.inventory_quantity > 0) {
      
      // 1. Buscar en Supabase si alguien está esperando esta variante exacta
      const { data: requests, error: fetchError } = await supabase
        .from('back_in_stock_requests')
        .select('*')
        .eq('variant_id', variant.id)
        .eq('notified', false);

      if (fetchError || !requests || requests.length === 0) continue;

      // 2. Enviar correos a todos los que estaban esperando
      for (const request of requests) {
        try {
          await resend.emails.send({
            from: 'Tu Tienda <noreply@izas-outdoor.com>', // Configura tu dominio en Resend
            to: request.email,
            subject: `¡Ya está disponible: ${request.product_title}!`,
            html: `
              <h2>¡Buenas noticias!</h2>
              <p>El producto <strong>${request.product_title}</strong> (Talla/Color: ${variant.title}) que estabas esperando acaba de reponerse.</p>
              <p><a href="https://tutienda.com/products/${product.handle}?variant=${variant.id}">Haz clic aquí para comprarlo antes de que se agote de nuevo</a></p>
            `
          });

          console.log(`[!] Email enviado a ${request.email}`);

          // 3. Marcar en Supabase como "notificado" para no volver a enviarle correo
          await supabase
            .from('back_in_stock_requests')
            .update({ notified: true })
            .eq('id', request.id);

        } catch (emailError) {
          console.error(`Error enviando email a ${request.email}:`, emailError);
        }
      }
    }
  }
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de avisos corriendo en el puerto ${PORT}`);
});
