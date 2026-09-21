import type { Locale } from '../types';

export const apiExecutionCopy: Record<Locale, { title: string; maxSteps: string; maxToolCalls: string; maxOutputTokens: string; cartographyMaxOutputTokens: string; hint: string; invalid: string }> = {
  "en": {
    "title": "API execution budget",
    "maxSteps": "Maximum model steps",
    "maxToolCalls": "Maximum tool calls",
    "maxOutputTokens": "Output tokens per call",
    "cartographyMaxOutputTokens": "Cartography output tokens",
    "hint": "Higher budgets may increase API costs. The output limit must be supported by your model.",
    "invalid": "Enter whole numbers within the displayed limits."
  },
  "zh-CN": {
    "title": "API 执行预算",
    "maxSteps": "最大模型调用步数",
    "maxToolCalls": "最大工具调用次数",
    "maxOutputTokens": "每次调用的输出 Token 上限",
    "cartographyMaxOutputTokens": "制图规范输出 Token 上限",
    "hint": "提高预算可能增加 API 费用，输出上限必须在所选模型支持的范围内。",
    "invalid": "请输入范围内的整数。"
  },
  "zh-TW": {
    "title": "API 執行預算",
    "maxSteps": "最大模型呼叫步數",
    "maxToolCalls": "最大工具呼叫次數",
    "maxOutputTokens": "每次呼叫的輸出 Token 上限",
    "cartographyMaxOutputTokens": "製圖規範輸出 Token 上限",
    "hint": "提高預算可能增加 API 費用，輸出上限必須在所選模型支援的範圍內。",
    "invalid": "請輸入範圍內的整數。"
  },
  "de": {
    "title": "API-Ausführungsbudget",
    "maxSteps": "Maximale Modellschritte",
    "maxToolCalls": "Maximale Werkzeugaufrufe",
    "maxOutputTokens": "Ausgabe-Tokens pro Aufruf",
    "cartographyMaxOutputTokens": "Kartografie-Ausgabe-Tokens",
    "hint": "Höhere Budgets können API-Kosten erhöhen. Das Modell muss das Ausgabelimit unterstützen.",
    "invalid": "Ganze Zahlen innerhalb der angegebenen Grenzen eingeben."
  },
  "fr": {
    "title": "Budget API",
    "maxSteps": "Étapes maximales du modèle",
    "maxToolCalls": "Appels d’outils maximaux",
    "maxOutputTokens": "Tokens de sortie par appel",
    "cartographyMaxOutputTokens": "Tokens de sortie cartographiques",
    "hint": "Un budget accru peut augmenter le coût. Le modèle doit prendre en charge la limite.",
    "invalid": "Saisissez des entiers dans les limites indiquées."
  },
  "es-ES": {
    "title": "Presupuesto de API",
    "maxSteps": "Pasos máximos del modelo",
    "maxToolCalls": "Llamadas máximas a herramientas",
    "maxOutputTokens": "Tokens de salida por llamada",
    "cartographyMaxOutputTokens": "Tokens de salida de cartografía",
    "hint": "Un presupuesto mayor puede aumentar los costes. El modelo debe admitir el límite.",
    "invalid": "Introduzca enteros dentro de los límites indicados."
  },
  "pt-BR": {
    "title": "Orçamento de API",
    "maxSteps": "Máximo de etapas do modelo",
    "maxToolCalls": "Máximo de chamadas de ferramentas",
    "maxOutputTokens": "Tokens de saída por chamada",
    "cartographyMaxOutputTokens": "Tokens de saída de cartografia",
    "hint": "Orçamentos maiores podem aumentar os custos. O modelo deve suportar o limite.",
    "invalid": "Insira números inteiros dentro dos limites indicados."
  },
  "it": {
    "title": "Budget API",
    "maxSteps": "Passi massimi del modello",
    "maxToolCalls": "Chiamate massime agli strumenti",
    "maxOutputTokens": "Token di output per chiamata",
    "cartographyMaxOutputTokens": "Token di output cartografici",
    "hint": "Budget maggiori possono aumentare i costi. Il modello deve supportare il limite.",
    "invalid": "Inserisci interi entro i limiti indicati."
  },
  "ja": {
    "title": "API 実行予算",
    "maxSteps": "モデルの最大ステップ数",
    "maxToolCalls": "ツールの最大呼び出し回数",
    "maxOutputTokens": "呼び出しごとの出力トークン上限",
    "cartographyMaxOutputTokens": "製図仕様の出力トークン上限",
    "hint": "予算を増やすと API 費用が増える場合があります。モデルが対応する出力上限を設定してください。",
    "invalid": "表示された範囲内の整数を入力してください。"
  },
  "ko": {
    "title": "API 실행 예산",
    "maxSteps": "최대 모델 단계",
    "maxToolCalls": "최대 도구 호출",
    "maxOutputTokens": "호출당 출력 토큰",
    "cartographyMaxOutputTokens": "지도 제작 규격 출력 토큰",
    "hint": "예산을 늘리면 API 비용이 증가할 수 있습니다. 모델이 지원하는 출력 한도를 설정하세요.",
    "invalid": "표시된 범위의 정수를 입력하세요."
  },
  "ru": {
    "title": "Бюджет API",
    "maxSteps": "Максимум шагов модели",
    "maxToolCalls": "Максимум вызовов инструментов",
    "maxOutputTokens": "Токены вывода за вызов",
    "cartographyMaxOutputTokens": "Токены картографического вывода",
    "hint": "Больший бюджет может увеличить расходы. Модель должна поддерживать лимит вывода.",
    "invalid": "Введите целые числа в указанных пределах."
  },
  "uk": {
    "title": "Бюджет API",
    "maxSteps": "Максимум кроків моделі",
    "maxToolCalls": "Максимум викликів інструментів",
    "maxOutputTokens": "Токени виводу за виклик",
    "cartographyMaxOutputTokens": "Токени картографічного виводу",
    "hint": "Більший бюджет може збільшити витрати. Модель має підтримувати ліміт виводу.",
    "invalid": "Введіть цілі числа у вказаних межах."
  },
  "pl": {
    "title": "Budżet API",
    "maxSteps": "Maksymalna liczba kroków modelu",
    "maxToolCalls": "Maksymalna liczba wywołań narzędzi",
    "maxOutputTokens": "Tokeny wyjściowe na wywołanie",
    "cartographyMaxOutputTokens": "Tokeny wyjściowe kartografii",
    "hint": "Wyższy budżet może zwiększyć koszty. Model musi obsługiwać limit wyjściowy.",
    "invalid": "Wprowadź liczby całkowite w podanym zakresie."
  },
  "hu": {
    "title": "API-keret",
    "maxSteps": "Modelllépések maximuma",
    "maxToolCalls": "Eszközhívások maximuma",
    "maxOutputTokens": "Kimeneti tokenek hívásonként",
    "cartographyMaxOutputTokens": "Kartográfiai kimeneti tokenek",
    "hint": "A nagyobb keret növelheti a költségeket. A modellnek támogatnia kell a kimeneti korlátot.",
    "invalid": "Adjon meg egész számokat a jelzett tartományban."
  },
  "id": {
    "title": "Anggaran API",
    "maxSteps": "Langkah model maksimum",
    "maxToolCalls": "Panggilan alat maksimum",
    "maxOutputTokens": "Token keluaran per panggilan",
    "cartographyMaxOutputTokens": "Token keluaran kartografi",
    "hint": "Anggaran lebih tinggi dapat meningkatkan biaya. Model harus mendukung batas keluaran.",
    "invalid": "Masukkan bilangan bulat dalam batas yang ditampilkan."
  },
  "tr": {
    "title": "API bütçesi",
    "maxSteps": "Azami model adımı",
    "maxToolCalls": "Azami araç çağrısı",
    "maxOutputTokens": "Çağrı başına çıktı tokeni",
    "cartographyMaxOutputTokens": "Kartografya çıktı tokeni",
    "hint": "Daha yüksek bütçe maliyeti artırabilir. Model çıktı sınırını desteklemelidir.",
    "invalid": "Gösterilen sınırlar içinde tam sayılar girin."
  },
  "ar": {
    "title": "ميزانية API",
    "maxSteps": "الحد الأقصى لخطوات النموذج",
    "maxToolCalls": "الحد الأقصى لاستدعاءات الأدوات",
    "maxOutputTokens": "رموز الإخراج لكل استدعاء",
    "cartographyMaxOutputTokens": "رموز إخراج مواصفات الخرائط",
    "hint": "قد تزيد الميزانية الأعلى التكلفة. يجب أن يدعم النموذج حد الإخراج.",
    "invalid": "أدخل أعدادًا صحيحة ضمن الحدود المعروضة."
  },
  "fa": {
    "title": "بودجه API",
    "maxSteps": "حداکثر مراحل مدل",
    "maxToolCalls": "حداکثر فراخوانی ابزار",
    "maxOutputTokens": "توکن خروجی هر فراخوانی",
    "cartographyMaxOutputTokens": "توکن خروجی مشخصات نقشه",
    "hint": "بودجه بالاتر ممکن است هزینه را افزایش دهد. مدل باید از حد خروجی پشتیبانی کند.",
    "invalid": "اعداد صحیح در محدوده نمایش‌داده‌شده وارد کنید."
  },
  "th": {
    "title": "งบประมาณ API",
    "maxSteps": "ขั้นตอนโมเดลสูงสุด",
    "maxToolCalls": "การเรียกเครื่องมือสูงสุด",
    "maxOutputTokens": "โทเคนเอาต์พุตต่อครั้ง",
    "cartographyMaxOutputTokens": "โทเคนเอาต์พุตข้อกำหนดแผนที่",
    "hint": "งบประมาณที่สูงขึ้นอาจเพิ่มค่าใช้จ่าย โมเดลต้องรองรับขีดจำกัดเอาต์พุต",
    "invalid": "ป้อนจำนวนเต็มภายในขอบเขตที่แสดง"
  }
};
