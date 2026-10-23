# Fuzzer Manual Cloud

El Fuzzer Manual en tu PC; los juegos y clics en GitHub. Cloudflare coordina los
comandos y guarda las capturas en R2 privado. La PC descarga cada JPEG antes de
mostrarlo y conserva las marcas, caminos e historial en SQLite.

## Uso

1. Abrí **Iniciar.cmd** y entrá a http://127.0.0.1:4180.
2. **Importar**: pegá enlaces DEMO oficiales o cargá un TXT.
3. Elegí workers, juegos por worker y duración; pulsá **Iniciar workers**.
   Se necesita GitHub CLI autenticado y acceso a este repo privado.
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
