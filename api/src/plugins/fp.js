// Крошечная замена fastify-plugin: снимает инкапсуляцию, чтобы декораторы
// плагина были видны во всём приложении. Отдельная зависимость ради этого лишняя.
export default function fp(fn) {
  fn[Symbol.for("skip-override")] = true;
  return fn;
}
