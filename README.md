# Fuzzer Manual Cloud

El Fuzzer Manual en tu PC; los juegos y clics en GitHub. Cloudflare coordina los
comandos y guarda las capturas en R2 privado. La PC descarga cada JPEG antes de
mostrarlo y conserva las marcas, caminos e historial en SQLite.

## Uso

1. Abrí **Iniciar.cmd** y entrá a http://127.0.0.1:4180.
2. **Importar**: pegá enlaces DEMO oficiales o cargá un TXT.
3. Elegí workers, juegos por worker y duración; pulsá **Iniciar workers**.
   Se necesita GitHub CLI autenticado con acceso a este repositorio público.
4. Clic izquierdo marca un punto; derecho prueba antebet. Podés marcar varios
   puntos de un menú inicial. **Espacio** guarda y avanza; **Z** deshace;
   **Shift+Espacio** vuelve a la foto anterior.
5. En una compra/bonus vivo, elegí una continuación por vez. El siguiente comando
   vuelve al worker que conserva esa sesión, sin volver a pagar para reconstruirla.
6. **Actualizar captura sin hacer clic** fotografía la sesión original sin comprar,
   girar ni recargar el navegador. Permite esperar o comprobar avances.
7. **Registro** muestra completados, pendientes e incidencias. Exporta JSON con
   coordenadas, caminos, datos de la imagen y evidencia de cierre; también CSV.
8. **Pausar** frena preparaciones nuevas. **Apagar workers** termina la operación
   activa y cierra sesiones. Cerrar la PC no apaga la flota automáticamente.

Fotos: `data/shots/`. Historial: `data/catalog.sqlite`. Identidad de la PC:
`data/cloud-client-id`. No borres esa identidad para retomar comandos existentes.
La RAM usa caché limitado; las fotos generadas permanecen en disco.

## Arquitectura y comportamiento

La PC conserva la interfaz del Fuzzer Manual y sus 26 proveedores. Nunca abre un
navegador de juegos: solo descarga imágenes, recibe tus marcas y envía comandos.
Un Worker con D1 lleva la cola; R2 almacena JPEG y metadatos. GitHub mantiene un
Chrome compartido por worker, con hasta ocho contextos vivos aislados.

Cada comando tiene una identidad persistente. Reenviar una petición recupera el
mismo resultado; no repite clics. Los bonus aleatorios quedan ligados al worker
original. Si se pierde, se registra una operación incierta y no se reconstruye
comprando otra vez. Los menús deterministas sí pueden abrirse en contextos nuevos.

Inicio de bonus, premio pendiente y compra completada son estados diferentes.
Una compra nueva no cuenta como completada solo por confirmar o entrar al bonus.
En controles reconocidos se exige resultado y regreso a la pantalla base.
La detección automática de cierre cubre los casos Pragmatic observados; otros
proveedores pueden necesitar revisión manual. Archivar una foto no prueba un premio.

Se conservan los límites iniciales del manual: un juego por minuto y hasta 100
juegos/fotos por proveedor para preparación. Las continuaciones de bonus no
quedan bloqueadas por un buffer lleno. Los juegos importados tienen prioridad.

Se pueden solicitar 1–20 workers y 1–8 juegos por worker; GitHub determina la
concurrencia efectiva de la cuenta. La duración predeterminada es 60 minutos,
ajustable entre 5 y 300. El workflow usa Chrome preinstalado, sin reinstalarlo
por ronda. Solo hay una flota por identificador de PC.

## Instalación en otra PC

Node >=22.13, GitHub CLI y `npm ci --ignore-scripts`. Copiá `.env.example` a `.env`
y configurá CLOUD_URL y CLOUD_CLIENT_TOKEN; después `npm start`. El identificador
se crea automáticamente. En esta PC Iniciar.ps1 puede leer credenciales cifradas
por Windows desde `.local/credentials.xml`, válido solo para este usuario Windows.
Nunca copies WORKER_TOKEN al navegador ni subas `.env` o `data/` a Git.

## Cloudflare y GitHub

`wrangler.jsonc` usa recursos separados del Hybrid: Worker fuzzer-manual-cloud,
D1 fuzzer-manual-cloud y R2 fuzzer-manual-cloud-images. No modifica el proyecto anterior.

```sh
npm ci --ignore-scripts
npm run check
npm test
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put CLIENT_TOKEN
npx wrangler secret put WORKER_TOKEN
npx wrangler deploy
```

En GitHub: variable CLOUD_URL y secreto CLOUD_WORKER_TOKEN. La PC solo usa el token
de cliente; el worker solo el token de ejecución. Las fotos y credenciales no se
publican en el repo ni en los artifacts de GitHub. Los datos del manual original
no se migran ni se modifican automáticamente.

## Verificación

`npm test` incluye pruebas heredadas del manual y pruebas nuevas de deduplicación,
claims concurrentes, afinidad, expiración incierta, permisos, apagado cooperativo,
descarga local y finalización del bonus. Una pérdida de sesión conserva la
incidencia; una prueba nueva no se presenta como recuperación de la compra perdida.

## Repositorio público

El código y el workflow manual-workers.yml se publican en Fuzzer-Manual-Cloud.
Las capturas permanecen en R2 privado y en data/shots de tu PC; SQLite, .env y
credenciales cifradas están excluidos de Git. La flota se ejecuta directamente
en este repositorio, sin depender del workflow del Hybrid anterior.


### Si una captura todavía está cargando
Elegí 10, 30 o 60 segundos y pulsá **Sigue cargando · esperar y capturar**. El worker espera sobre la misma página y devuelve una imagen nueva, sin hacer clic, sin recargar y sin cerrar el camino. Podés repetirlo cuantas veces sea necesario. **Actualizar captura sin hacer clic** obtiene una imagen inmediata.

Las sesiones iniciales permanecen abiertas dentro del límite de juegos por worker. Si una captura inicial antigua ya fue archivada, se abre de nuevo solamente esa pantalla inicial; una compra o tirada perdida nunca se repite automáticamente. No marques botones sobre una pantalla de carga: esperá la nueva captura. Los workers deben estar encendidos.


### Juegos, operaciones y clics anteriores
La cola tiene una sola tarjeta por juego. Si un juego tiene varias operaciones pendientes, elegí la operación desde el selector sobre la imagen. Solo se muestra una captura de la operación elegida; al actualizarla, reemplaza la anterior. El encabezado identifica proveedor, juego, operación y captura. También indica si es un inicio independiente, una continuación vinculada o una ruta vinculada en una sesión nueva. **Ver pantalla anterior** permite revisar su origen.

Tras enviar marcas, la vista espera la siguiente captura del mismo juego. Para trabajar en otro mientras tanto, seleccioná su tarjeta. Los clics anteriores ejecutados aparecen en verde con ✓ únicamente cuando coinciden la imagen, el estado y las dimensiones; las marcas nuevas son azules. El historial por juego conserva los clics de todas las rutas con su estado: ejecutado, pendiente, no ejecutado o sin confirmar. Una tirada iniciada no implica que haya terminado ni que una compra esté completada. Si el proveedor no identifica el control, se registra como clic manual y se conserva su nota.


Los juegos nuevos tienen **un minuto de carga por defecto** antes de entregar la primera captura. Las continuaciones no reciben una espera extra obligatoria. La opción de espera adicional también arranca en 60 segundos y funciona por juego: podés pedir una recaptura en A, seleccionar B y pedir otra sin esperar a A. Las tarjetas muestran «Esperando captura…» y los clics quedan bloqueados solo en la operación que está actualizándose. La flota que ya estaba abierta conserva sus sesiones y recibe esta espera inicial desde el cliente, sin cerrar los juegos.


Si una tarjeta dice **Esperando worker libre**, todavía no empezó su captura: falta una sesión disponible. **Capturando en worker** indica que ya se ejecuta. Los fallos pasajeros de consulta a D1 no cierran de inmediato los navegadores. Si hay trabajo pendiente y se perdió parte de la flota, el lanzador repone solo los workers que faltan, con una pausa entre intentos; **Apagar workers** desactiva esta recuperación. Las flotas de reposición conservan las sesiones originales y no repiten compras ni tiradas.

Los clics ejecutados se indican directamente sobre su coordenada con un ✓ verde. Las listas laterales de clics están ocultas; el historial continúa guardado y disponible en la exportación.


### Marcar una tanda completa
Podés marcar varias opciones sobre la misma fotografía y guardarlas juntas: clic izquierdo = ejecutar en esa coordenada; clic derecho = antebet y una orden de tirada. Cada marca crea su propia operación vinculada a la fotografía de origen, sin pedirte que vuelvas a marcarla. El motor conserva la primera rama y reconstruye las otras desde su ruta y la verifica visualmente. Si esa ruta exige repetir una compra o tirada anterior identificada, queda un problema explícito en vez de repetirla silenciosamente.

El ✓ verde con **Último clic** muestra la posición de la acción ejecutada que produjo la imagen actual, aunque hayan cambiado los carretes o el estado. Los otros indicadores verdes requieren coincidencia de pantalla. En proveedores genéricos la orden de tirada de antebet se envía mediante Space; el resultado queda pendiente de verificación si el proveedor no permite confirmar su finalización. No todos los juegos implementan ese atajo.


### Secuencias explícitas con clic derecho (versión sequence3)
El clic derecho ya no infiere antebet ni envía Space. Marcá con clic derecho el interruptor y después el botón de tirada: se dibujan S1 y S2. Al guardar, esos puntos forman **una sola operación** que pulsa ambas coordenadas, en ese orden, con una pausa de 700 ms. Entre los puntos no se exige reconocer otra pantalla. Los clics izquierdos siguen creando opciones independientes; podés combinarlos con una secuencia en la misma fotografía. Las coordenadas, su orden y los pasos efectivamente enviados quedan guardados. Un fallo incierto no repite el punto automáticamente.

El cargador usa la capacidad libre con una separación de dos segundos entre nuevas cargas del mismo proveedor, conservando los límites de 8 juegos por worker y el buffer de 100. El minuto inicial corresponde a cada juego y transcurre en paralelo. La configuración anterior de un juego por minuto y la serialización por proveedor ya no se usan en este cliente cloud.


## Requests, endpoints y payloads (v4)

En la interfaz local, **Requests y HAR → Recuperar requests del historial** recorre automáticamente las ramas y secuencias de clics guardadas en SQLite. Usa sesiones nuevas en los workers GitHub `har4`, hasta 8 juegos por worker. Pausa la preparación normal para dedicar la flota a esta recuperación. El historial original no se modifica y no hace falta volver a marcar las capturas.

Cada ruta produce un HAR 1.2 completo: URL y query, método, encabezados, cookies, `postData` y cuerpos de respuesta terminados. Los frames WebSocket van en un archivo JSONL separado. El registro de acciones incluye marcas originales, orden y hora para relacionarlas con el tráfico. El HAR se escribe al cerrar el contexto; una sesión todavía abierta no tiene un archivo final disponible.

Los archivos se comprimen, verifican por SHA-256, se transfieren por endpoints autenticados a R2 privado y se descargan en `data/network/` de la PC. La ventana permite descargar el HAR y las acciones vinculadas. Los informes persistentes están en `data/replays/` y se pueden exportar desde esa misma ventana. Ninguno de estos datos se publica en GitHub.

Esto **reconstruye tráfico nuevo**. No recupera los requests históricos que nunca se grabaron, ni garantiza los mismos premios aleatorios. Si la pantalla no coincide o faltan coordenadas de una acción antigua, la ruta se detiene y queda parcial con su motivo y el tráfico capturado hasta ese punto. Un clic de resultado incierto no se reenvía automáticamente. El estado `replayed` significa que se enviaron las acciones guardadas y se archivó su HAR; no certifica una compra completa.
