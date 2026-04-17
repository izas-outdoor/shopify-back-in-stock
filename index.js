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
  // Respondemos rápido a Shopify
  res.status(200).send('Webhook recibido');

  const product = req.body;
  if (!product || !product.variants) return;

  // Recorremos todas las variantes
  for (const variant of product.variants) {
    if (variant.inventory_quantity > 0) {
      
      // 1. Buscar en Supabase si alguien espera esta variante
      const { data: requests, error: fetchError } = await supabase
        .from('back_in_stock_requests')
        .select('*')
        .eq('variant_id', variant.id)
        .eq('notified', false);

      if (fetchError || !requests || requests.length === 0) continue;

      // 2. LÓGICA DE LA IMAGEN DE LA VARIANTE
      let imageUrl = '';
      if (variant.image_id && product.images) {
        // Buscamos la imagen exacta de la variante
        const variantImage = product.images.find(img => img.id === variant.image_id);
        if (variantImage) imageUrl = variantImage.src;
      }
      // Si no tiene imagen propia, usamos la principal del producto
      if (!imageUrl && product.image) {
        imageUrl = product.image.src;
      }
      // Si no hay imágenes en absoluto, un placeholder
      if (!imageUrl) {
        imageUrl = 'https://cdn.shopify.com/s/images/admin/no-image-large.gif'; 
      }

      // 3. Enviar los correos maquetados
      for (const request of requests) {
        try {
          await resend.emails.send({
            from: 'Izas Outdoor <avisos@izas-outdoor.com>', // Asegúrate de que este es tu correo verificado
            to: request.email,
            subject: `¡Ya está disponible: ${request.product_title}!`,
            html: `
              <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e4e4e4; border-radius: 8px; overflow: hidden;">
                
                <div style="background-color: #000000; padding: 20px; text-align: center;">
                  <img src="https://cdn.shopify.com/s/files/1/0834/1579/3985/files/logo-izas-blanco.svg?v=1699971182" alt="Izas Outdoor" style="max-height: 40px;">
                </div>

                <div style="padding: 40px 30px; text-align: center;">
                  <h2 style="color: #333333; margin-top: 0; font-size: 24px;">¡Buenas noticias!</h2>
                  <p style="color: #666666; font-size: 16px; line-height: 1.5;">
                    El artículo que estabas esperando acaba de volver a nuestro almacén. No lo dejes escapar, ¡el stock vuela!
                  </p>

                  <div style="margin: 30px 0; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
                    <img src="${imageUrl}" alt="${request.product_title}" style="max-width: 200px; border-radius: 4px; margin-bottom: 15px; object-fit: cover;">
                    <h3 style="color: #333333; margin: 0 0 5px 0; font-size: 18px;">${request.product_title}</h3>
                    <p style="color: #888888; margin: 0; font-size: 14px;">Variante: <strong style="color: #000;">${variant.title}</strong></p>
                  </div>

                  <a href="https://izas-outdoor.com/products/${product.handle}?variant=${variant.id}" style="display: inline-block; background-color: #000000; color: #ffffff; text-decoration: none; padding: 15px 30px; font-size: 16px; font-weight: bold; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">
                    Comprar Ahora
                  </a>
                </div>

                <div style="background-color: #f9f9f9; padding: 20px; text-align: center; color: #999999; font-size: 12px;">
                  <p style="margin: 0;">Has recibido este correo porque nos pediste que te avisáramos sobre este producto.</p>
                  <p style="margin: 5px 0 0 0;">&copy; Izas Outdoor. Todos los derechos reservados.</p>
                </div>

              </div>
            `
          });

          console.log(`[!] Email enviado a ${request.email}`);

          // 4. Marcar como notificado
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
