# Auditoría Técnica y Registro de Cambios: Documentación de Cátedra EDI 3

Este documento registra los hallazgos técnicos, correcciones conceptuales y calibraciones aplicadas a los apuntes de la materia extraídos de las diapositivas y guías de cátedra originales, siguiendo la metodología de **Linus Torvalds** (*KISS, estructuras de datos sólidas, eliminación de casos especiales y cero sobreingeniería*) y los estándares de seguridad de **OWASP para LLMs (2025)**.

---

## 1. Resumen Ejecutivo de Hallazgos

Al revisar el material original (presentaciones PPTX y guías PDF de los Capítulos 01, 02, 03, 03b, 04 y 08), se detectó que los temas base son pedagógicamente correctos pero presentaban **cuatro categorías de inconsistencias o riesgos para entornos de producción**:

1. **Ambigüedad Teórica / Mezcla de Paradigmas:** Confusión entre cómo extraen patrones las redes convolucionales de visión (CNNs) frente al mecanismo de atención de los Transformers.
2. **Imprecisión Matemática en Espacios Vectoriales:** Presentación de Coseno, Euclidiana y Producto Punto como métricas radicalmente distintas sin explicitar la equivalencia bajo normalización.
3. **Falsa Sensación de Seguridad en Prompts:** Tratar a los delimitadores XML (`<documento>...</documento>`) como una solución absoluta contra inyecciones de prompt.
4. **Desconexión con Motores de Bases de Datos Reales:** Proponer índices HNSW en `pgvector` sin advertir sobre la degradación de rendimiento al aplicar filtros relacionales estrictos de aislamiento multitenant.

---

## 2. Detalle de Cambios por Documento y Justificación

### Tema 01 · Fundamentos de Inteligencia Artificial
* **Archivo:** [`docs/knowledge/01_Fundamentos_IA_Apuntes.md`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/01_Fundamentos_IA_Apuntes.md)
* **Texto original en diapositiva:** Se afirmaba genéricamente que las redes neuronales profundas extraen representaciones *"bordes $\to$ formas $\to$ conceptos"*.
* **Corrección aplicada:** Se diferenció expresamente la visión por computadora (CNNs) de los Modelos de Lenguaje (Transformers).
* **Justificación técnica:** En un LLM no existen filtros convolucionales locales para bordes; las capas calculan proyecciones matriciales de **atención contextual dinámica (*Self-Attention*)** entre pares de tokens en toda la secuencia. Enseñar lo contrario induce a error conceptual sobre cómo opera la memoria de trabajo de un transformer.

---

### Tema 02 · Cómo Funcionan los LLM & Embeddings
* **Archivo:** [`docs/knowledge/02_Como_Funcionan_los_LLM_Apuntes.md`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/02_Como_Funcionan_los_LLM_Apuntes.md)
* **Cambio 1: Equivalencia Geométrica bajo Normalización:**
  - *Problema original:* Se presentaba la distancia Euclidiana, el Producto Punto y la Similitud Coseno como tres criterios independientes y comparables con ejemplos ad-hoc.
  - *Ajuste Linus:* Se incorporó la demostración formal: si los vectores están normalizados a norma unitaria ($\|\mathbf{u}\| = 1, \|\mathbf{v}\| = 1$), el producto punto es idéntico a la similitud coseno ($\mathbf{u} \cdot \mathbf{v} = \cos\theta$) y la distancia euclidiana es directamente $\|\mathbf{u} - \mathbf{v}\|^2 = 2 - 2\cos\theta$.
  - *Por qué:* Ahorra cómputo crítico en hardware. En producción se normalizan los embeddings al ingestarlos y la búsqueda vectorial se reduce a un producto punto puro en hardware (GPU/SIMD).
* **Cambio 2: Asimetría de Costos Input vs. Output:**
  - *Problema original:* Se mencionaba que los tokens de salida son 3x-4x más caros como un dato comercial.
  - *Ajuste:* Se explicó la causa de arquitectura de cómputo: el prompt de entrada se procesa en paralelo en GPU en un único paso matricial, mientras que la salida es **estrictamente autorregresiva y secuencial**, dominada por el ancho de banda de memoria de la GPU (*memory-bandwidth bound*).

---

### Tema 03b · Prompt Injection y Jailbreak en LLMs
* **Archivo:** [`docs/knowledge/03b_Prompt_Injection_y_Jailbreak_Apuntes.md`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/03b_Prompt_Injection_y_Jailbreak_Apuntes.md)
* **Texto original:** Se sugería que delimitar las entradas con tags XML (`<documento>`) y decirle al modelo que no obedezca órdenes previene la inyección.
* **Corrección aplicada:** Se añadió una advertencia crítica de seguridad (**Principio Linus de Confianza Cero**). Delimitar es solo una heurística probabilística mitigadora; **no es una barrera infalible** (comparable a limpiar SQL a mano con expresiones regulares).
* **Regla inquebrantable agregada:** La salida del LLM es siempre **entrada no confiable (`untrusted input`)**. Nunca debe encadenarse a un intérprete de comandos (`bash`), a un `eval()` o a queries SQL dinámicas sin parametrizar.

---

### Tema 04 · RAG y Embeddings (Bases de Datos Vectoriales)
* **Archivo:** [`docs/knowledge/04_RAG_y_Embeddings_Apuntes.md`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/04_RAG_y_Embeddings_Apuntes.md)
* **Texto original:** Proponía un índice `CREATE INDEX ON fragmentos USING hnsw (embedding vector_cosine_ops);` y luego un `SELECT ... WHERE cliente_id = :id ORDER BY embedding <=> :q LIMIT 5`.
* **Corrección aplicada:** Advertencia sobre el comportamiento de grafos HNSW ante filtrado post-recuperación en PostgreSQL (`pgvector`).
* **Por qué:** Si un cliente tiene pocos registros dentro de una tabla de millones de filas, la búsqueda aproximada por grafo HNSW puede quedar atrapada en clusters de otros clientes y devolver cero resultados o degradar bruscamente la latencia. Se documentó la alternativa de **particionado por tenant** o índices compuestos según la escala de datos.

---

### Tema 08 · Seguridad y Producción
* **Archivo:** [`docs/knowledge/08_Seguridad_y_Produccion_Apuntes.md`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/08_Seguridad_y_Produccion_Apuntes.md)
* **Texto original:** Ponía al mismo nivel de evaluación las pruebas exactas y el patrón "LLM como Juez".
* **Corrección aplicada:** Establecimiento de la **Jerarquía de Precedencia en CI**:
  1. *Prioridad 1 (Aserciones deterministas):* Validación estricta de esquemas JSON con Zod/Pydantic, tipos y códigos HTTP.
  2. *Prioridad 2 (Reglas sintácticas):* Presencia de metadatos, longitud de respuesta y citas obligatorias.
  3. *Prioridad 3 (LLM como juez):* Únicamente complementario para tono/semántica, jamás como bloqueante ciego de despliegues debido al sesgo circular y no determinismo estocástico.

---

## 3. Estado de los Documentos en el Proyecto

Todos los apuntes corregidos residen en [`docs/knowledge/`](file:///home/jmro/Documents/Development/edi3-ai-production/docs/knowledge/) y constituyen la base de entrenamiento y recuperación semántica del microservicio RAG que implementará este repositorio.
