# Apuntes: Capítulo 02 · Cómo Funcionan los LLM
> **Curso:** Curso Inicial de IA para Desarrolladores (EDI 3 - TECDA 3º)  
> **Documento fuente:** [`TERCERO/EDI_3/02 - Cómo funcionan los LLM.pptx`](file:///home/jmro/Documents/Academy/TECDA/TERCERO/EDI_3/02%20-%20C%C3%B3mo%20funcionan%20los%20LLM.pptx)  
> **Eje temático:** Mecánica interna, predicción de tokens, geometría de embeddings, métricas vectoriales y arquitectura para desarrolladores.

---

## 1. La Mecánica Interna: El Motor Estadístico

Un Large Language Model (LLM) no razona con consciencia biológica; es un **motor probabilístico de predicción de tokens**:
- Ante la secuencia: *"El perro está..."*
- El modelo calcula la distribución de probabilidad sobre su vocabulario:
  - `" corriendo"` $\to 55\%$
  - `" durmiendo"` $\to 25\%$
  - `" en el"` $\to 12\%$
- Emite un token y vuelve a retroalimentar la secuencia completa para calcular el siguiente (*autorregresión*).

---

## 2. Bloques Fundamentales del Modelo

1. **Tokens:**  
   Unidades atómicas de texto. No siempre son palabras enteras: suelen ser sub-palabras o combinaciones de caracteres.  
   - Regla empírica: $1\text{ token} \approx 4\text{ caracteres}$ o $\approx 0.75\text{ palabras}$ en inglés (en español el ratio suele ser mayor por morfología y acentos).
2. **Embeddings:**  
   Representaciones vectoriales continuas en un espacio multidimensional denso donde la distancia y el ángulo representan relaciones semánticas.
3. **Context Window (Ventana de Contexto):**  
   Memoria de trabajo máxima instantánea expresada en tokens. Engloba:  
   $$\text{Total Tokens} = \text{System Prompt} + \text{Historial Conversacional} + \text{Input Usuario} + \text{Output Esperado}$$

---

## 3. Del Texto a la Geometría: Embeddings

### 3.1 Búsqueda Léxica vs. Búsqueda Semántica

| Criterio | Búsqueda Léxica (Tradicional) | Búsqueda Semántica (Embeddings) |
| :--- | :--- | :--- |
| **Mecanismo** | Coincidencia exacta de palabras clave (*Keywords*) | Mapeo en espacio vectorial continuo |
| **Sinónimos** | Falla si no comparten letras (*"pago rechazado"* $\neq$ *"transacción denegada"*) | Agrupa conceptos equivalentes por proximidad |
| **Intención** | Ciega al contexto general | Interpreta la intención subyacente |

### 3.2 Espacio Vectorial Denso
- Los embeddings tradicionales dispersos (*Sparse*) usaban miles de ceros y una posición por palabra.
- Los modelos modernos generan **vectores densos** (ej. 768 o 1536 dimensiones flotantes).
- Cada dimensión codifica rasgos latentes abstractos (registro formal, carga afectiva, jerarquía de entidad, contexto técnico).
- Habilita operaciones de álgebra semántica:  
  $$\vec{v}(\text{"Rey"}) - \vec{v}(\text{"Hombre"}) + \vec{v}(\text{"Mujer"}) \approx \vec{v}(\text{"Reina"})$$

---

## 4. Métricas de Similitud Vectorial

```
            Bananas (Eje Y)
              ▲
              │      B (2,4) [Misma dirección que A, doble escala]
              │     /
              │    / 
              │   / A (1,2)
              │  /
              │ /  Ángulo 0° con B
              └─────────────────────► Manzanas (Eje X)
                                C (5,0) [Dirección perpendicular/dispar]
```

### 4.1 Fórmulas y Comportamiento

1. **Similitud del Coseno ($\cos \theta$):**
   $$\cos(\theta) = \frac{\mathbf{u} \cdot \mathbf{v}}{\|\mathbf{u}\| \|\mathbf{v}\|}$$
   - Mide el **ángulo** entre vectores ignorando su magnitud.
   - Ideal para NLP y búsqueda semántica (evalúa la temática o intención sin penalizar que un texto sea más largo que otro).
2. **Distancia Euclidiana ($L_2$):**
   $$d(\mathbf{u}, \mathbf{v}) = \sqrt{\sum (u_i - v_i)^2}$$
   - Mide la distancia geométrica directa en línea recta. Sensible al volumen y escala.
3. **Producto Punto (*Dot Product* / Inner Product):**
   $$\mathbf{u} \cdot \mathbf{v} = \sum u_i v_i$$
   - Combina coincidencia de ángulo con la magnitud de los vectores.

> **Demostración de Equivalencia bajo Normalización (Rigor Matemático):**  
> Si los vectores están normalizados a norma unitaria ($\|\mathbf{u}\| = 1, \|\mathbf{v}\| = 1$):
> 1. $\text{Similitud Coseno} = \mathbf{u} \cdot \mathbf{v}$ (coincide con el Producto Punto).
> 2. $\|\mathbf{u} - \mathbf{v}\|^2 = \|\mathbf{u}\|^2 + \|\mathbf{v}\|^2 - 2(\mathbf{u} \cdot \mathbf{v}) = 1 + 1 - 2\cos(\theta) = 2 - 2\cos(\theta)$.  
> Por ende, **ordenar por mayor similitud de coseno, mayor producto punto o menor distancia euclidiana produce exactamente el mismo ranking de búsqueda**. No hay diferencias conceptuales mágicas: normalizar ahorra cómputo al reducir la distancia a un producto punto puro en hardware.

---

## 5. El Problema de la Dilución de la Señal (Estrategia de Chunking)

* Si se toma un PDF de 50 páginas y se genera un único vector de 1536 dimensiones, ese vector debe condensar: historia, salarios, normativas, vacaciones, finanzas.
* Al buscar *"¿Cuántos días de vacaciones tengo?"*, el vector de la consulta no encontrará una coincidencia fuerte porque la señal de *"vacaciones"* está diluida en las 50 páginas.
* **El compromiso del Chunking:**
  - *Chunks diminutos (ej. "20 días"):* Pierden el contexto (¿20 días de qué?).
  - *Chunks gigantes (10 páginas):* Diluyen la señal conceptual.
  - *Equilibrio óptimo:* Fragmentos semánticos coherentes (párrafos de 250-500 tokens con overlap/solapamiento de 10-20%).

---

## 6. Evolución de las Redes y Búsquedas

### De Word2Vec a Transformers
- **Estáticos (Word2Vec / GloVe):** Asignaban un único vector fijo por palabra sin importar el contexto. *"Vino"* (bebida) y *"Vino"* (verbo venir) tenían el mismo vector.
- **Dinámicos (Transformers / BERT):** Calculan vectores en función del contexto global mediante **Self-Attention**. *"El vino tinto"* genera una coordenada distinta a *"Él vino tarde"*.

### Línea Temporal de la Búsqueda en Google
1. **1998 - PageRank:** Búsqueda sintáctica por coincidencia de strings y autoridad de hipervínculos.
2. **2012 - Knowledge Graph:** De *"strings"* a *"things"* (entidades y grafos).
3. **2013-2015 - Hummingbird & RankBrain:** Machine learning interpretando intenciones de búsqueda.
4. **2019-2021 - BERT & MUM:** Transformers aplicados a escala global y multimodalidad.
5. **Presente - RAG & AI Overviews:** Búsqueda vectorial, recuperación de chunks y generación sintética con LLMs.

---

## 7. Conceptos Clave de Ingeniería para Desarrolladores

### 7.1 Temperatura y Muestreo (*Sampling*)
- **Temperatura 0.0 (Greedy / Determinista):** Selecciona invariablemente el token con mayor probabilidad. Ideal para código, extracción JSON y respuestas factuales.
- **Temperatura 0.7 - 1.0 (Estocástica / Creativa):** Da oportunidad a tokens secundarios, produciendo respuestas más variadas y naturales.

### 7.2 Anatomía de Mensajes en la API
* `system`: Instrucciones fundamentales, restricciones y persona (máxima precedencia).
* `user`: Entrada del usuario en el turno actual.
* `assistant`: Respuestas emitidas por el modelo (se envían en llamadas sucesivas para mantener el hilo de memoria).

### 7.3 Economía y Rendimiento de APIs
* **Asimetría de costos (Causa de Hardware):**  
  Los *Output Tokens* suelen costar **3x a 4x más** que los *Input Tokens*. Esto no es una decisión comercial arbitraria: el procesamiento del prompt de entrada se realiza en un único paso matricial altamente paralelizable en GPU, mientras que la generación de tokens de salida es **estrictamente secuencial y autoregresiva (bound por ancho de banda de memoria de la GPU y latencia de acceso a pesos)**.
* **TTFT (Time To First Token):** Latencia inicial antes de que aparezca la primera palabra.
* **Streaming (Server-Sent Events - SSE):** Imprescindible en UX moderna para transmitir tokens al frontend mientras se generan en lugar de bloquear el hilo HTTP.
* **Rate Limits:** Medidos en RPM (*Requests Per Minute*) y TPM (*Tokens Per Minute*), exigiendo colas y backoff exponencial con jitter.
