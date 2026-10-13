import type { Locale } from '../types';

type Copy = { useDefaultMap: string; agent: string; selectAgent: string; agentRequired: string; fieldsRequired: string; createError: string; chooseDirectory: string; directorySelected: string; directoryError: string };
export const sourceFormCopy: Record<Locale, Copy> = {
  "en": {
    "useDefaultMap": "Use default map",
    "agent": "Local agent",
    "selectAgent": "Select an agent",
    "agentRequired": "Select an available local agent before continuing.",
    "fieldsRequired": "Complete the project name, map URL and design requirement.",
    "createError": "Unable to create the map project. Please try again.",
    "chooseDirectory": "Choose working directory",
    "directorySelected": "Working directory selected.",
    "directoryError": "Unable to choose a working directory."
  },
  "zh-CN": {
    "useDefaultMap": "使用默认地图",
    "agent": "本地智能体",
    "selectAgent": "选择智能体",
    "agentRequired": "请先选择可用的本地智能体。",
    "fieldsRequired": "请填写项目名称、地图地址和设计需求。",
    "createError": "无法创建地图项目，请重试。",
    "chooseDirectory": "选择工作目录",
    "directorySelected": "已选择工作目录。",
    "directoryError": "无法选择工作目录。"
  },
  "zh-TW": {
    "useDefaultMap": "使用預設地圖",
    "agent": "本機智慧體",
    "selectAgent": "選擇智慧體",
    "agentRequired": "請先選擇可用的本機智慧體。",
    "fieldsRequired": "請填寫專案名稱、地圖網址和設計需求。",
    "createError": "無法建立地圖專案，請重試。",
    "chooseDirectory": "選擇工作目錄",
    "directorySelected": "已選擇工作目錄。",
    "directoryError": "無法選擇工作目錄。"
  },
  "de": {
    "useDefaultMap": "Standardkarte verwenden",
    "agent": "Lokaler Agent",
    "selectAgent": "Agent auswählen",
    "agentRequired": "Wählen Sie zuerst einen verfügbaren lokalen Agenten.",
    "fieldsRequired": "Projektname, Karten-URL und Designanforderung ausfüllen.",
    "createError": "Kartenprojekt konnte nicht erstellt werden. Bitte erneut versuchen.",
    "chooseDirectory": "Arbeitsverzeichnis wählen",
    "directorySelected": "Arbeitsverzeichnis ausgewählt.",
    "directoryError": "Arbeitsverzeichnis konnte nicht gewählt werden."
  },
  "fr": {
    "useDefaultMap": "Utiliser la carte par défaut",
    "agent": "Agent local",
    "selectAgent": "Choisir un agent",
    "agentRequired": "Choisissez d’abord un agent local disponible.",
    "fieldsRequired": "Renseignez le nom du projet, l’URL et les besoins de conception.",
    "createError": "Impossible de créer le projet. Réessayez.",
    "chooseDirectory": "Choisir le dossier de travail",
    "directorySelected": "Dossier de travail sélectionné.",
    "directoryError": "Impossible de choisir le dossier de travail."
  },
  "es-ES": {
    "useDefaultMap": "Usar mapa predeterminado",
    "agent": "Agente local",
    "selectAgent": "Seleccionar agente",
    "agentRequired": "Selecciona primero un agente local disponible.",
    "fieldsRequired": "Completa el nombre, la URL del mapa y los requisitos de diseño.",
    "createError": "No se pudo crear el proyecto. Inténtalo de nuevo.",
    "chooseDirectory": "Elegir directorio de trabajo",
    "directorySelected": "Directorio de trabajo seleccionado.",
    "directoryError": "No se pudo elegir el directorio de trabajo."
  },
  "pt-BR": {
    "useDefaultMap": "Usar mapa padrão",
    "agent": "Agente local",
    "selectAgent": "Selecionar agente",
    "agentRequired": "Selecione primeiro um agente local disponível.",
    "fieldsRequired": "Preencha o nome do projeto, a URL e os requisitos de design.",
    "createError": "Não foi possível criar o projeto. Tente novamente.",
    "chooseDirectory": "Escolher diretório de trabalho",
    "directorySelected": "Diretório de trabalho selecionado.",
    "directoryError": "Não foi possível escolher o diretório de trabalho."
  },
  "it": {
    "useDefaultMap": "Usa mappa predefinita",
    "agent": "Agente locale",
    "selectAgent": "Seleziona agente",
    "agentRequired": "Seleziona prima un agente locale disponibile.",
    "fieldsRequired": "Compila nome del progetto, URL e requisiti di progettazione.",
    "createError": "Impossibile creare il progetto. Riprova.",
    "chooseDirectory": "Scegli cartella di lavoro",
    "directorySelected": "Cartella di lavoro selezionata.",
    "directoryError": "Impossibile scegliere la cartella di lavoro."
  },
  "ja": {
    "useDefaultMap": "デフォルトの地図を使う",
    "agent": "ローカルエージェント",
    "selectAgent": "エージェントを選択",
    "agentRequired": "利用可能なローカルエージェントを選択してください。",
    "fieldsRequired": "プロジェクト名、地図URL、デザイン要件を入力してください。",
    "createError": "地図プロジェクトを作成できません。再試行してください。",
    "chooseDirectory": "作業フォルダーを選択",
    "directorySelected": "作業フォルダーを選択しました。",
    "directoryError": "作業フォルダーを選択できません。"
  },
  "ko": {
    "useDefaultMap": "기본 지도 사용",
    "agent": "로컬 에이전트",
    "selectAgent": "에이전트 선택",
    "agentRequired": "사용 가능한 로컬 에이전트를 먼저 선택하세요.",
    "fieldsRequired": "프로젝트 이름, 지도 URL, 디자인 요구 사항을 입력하세요.",
    "createError": "지도 프로젝트를 만들 수 없습니다. 다시 시도하세요.",
    "chooseDirectory": "작업 폴더 선택",
    "directorySelected": "작업 폴더가 선택되었습니다.",
    "directoryError": "작업 폴더를 선택할 수 없습니다."
  },
  "id": {
    "useDefaultMap": "Gunakan peta bawaan",
    "agent": "Agen lokal",
    "selectAgent": "Pilih agen",
    "agentRequired": "Pilih agen lokal yang tersedia terlebih dahulu.",
    "fieldsRequired": "Lengkapi nama proyek, URL peta, dan kebutuhan desain.",
    "createError": "Proyek peta tidak dapat dibuat. Coba lagi.",
    "chooseDirectory": "Pilih direktori kerja",
    "directorySelected": "Direktori kerja dipilih.",
    "directoryError": "Direktori kerja tidak dapat dipilih."
  },
  "ru": {
    "useDefaultMap": "Использовать карту по умолчанию",
    "agent": "Локальный агент",
    "selectAgent": "Выберите агента",
    "agentRequired": "Сначала выберите доступного локального агента.",
    "fieldsRequired": "Заполните название проекта, URL карты и требования к дизайну.",
    "createError": "Не удалось создать проект. Попробуйте снова.",
    "chooseDirectory": "Выбрать рабочий каталог",
    "directorySelected": "Рабочий каталог выбран.",
    "directoryError": "Не удалось выбрать рабочий каталог."
  },
  "uk": {
    "useDefaultMap": "Використати типову карту",
    "agent": "Локальний агент",
    "selectAgent": "Виберіть агента",
    "agentRequired": "Спочатку виберіть доступного локального агента.",
    "fieldsRequired": "Заповніть назву проєкту, URL карти та вимоги до дизайну.",
    "createError": "Не вдалося створити проєкт. Спробуйте знову.",
    "chooseDirectory": "Вибрати робочий каталог",
    "directorySelected": "Робочий каталог вибрано.",
    "directoryError": "Не вдалося вибрати робочий каталог."
  },
  "pl": {
    "useDefaultMap": "Użyj mapy domyślnej",
    "agent": "Lokalny agent",
    "selectAgent": "Wybierz agenta",
    "agentRequired": "Najpierw wybierz dostępnego lokalnego agenta.",
    "fieldsRequired": "Uzupełnij nazwę projektu, URL mapy i wymagania projektowe.",
    "createError": "Nie udało się utworzyć projektu. Spróbuj ponownie.",
    "chooseDirectory": "Wybierz katalog roboczy",
    "directorySelected": "Wybrano katalog roboczy.",
    "directoryError": "Nie udało się wybrać katalogu roboczego."
  },
  "hu": {
    "useDefaultMap": "Alapértelmezett térkép használata",
    "agent": "Helyi ügynök",
    "selectAgent": "Ügynök kiválasztása",
    "agentRequired": "Először válasszon elérhető helyi ügynököt.",
    "fieldsRequired": "Adja meg a projekt nevét, a térkép URL-jét és a tervezési igényt.",
    "createError": "A projekt nem hozható létre. Próbálja újra.",
    "chooseDirectory": "Munkakönyvtár kiválasztása",
    "directorySelected": "Munkakönyvtár kiválasztva.",
    "directoryError": "A munkakönyvtár nem választható ki."
  },
  "tr": {
    "useDefaultMap": "Varsayılan haritayı kullan",
    "agent": "Yerel ajan",
    "selectAgent": "Ajan seç",
    "agentRequired": "Önce kullanılabilir bir yerel ajan seçin.",
    "fieldsRequired": "Proje adını, harita URL’sini ve tasarım gereksinimini doldurun.",
    "createError": "Harita projesi oluşturulamadı. Tekrar deneyin.",
    "chooseDirectory": "Çalışma dizini seç",
    "directorySelected": "Çalışma dizini seçildi.",
    "directoryError": "Çalışma dizini seçilemedi."
  },
  "th": {
    "useDefaultMap": "ใช้แผนที่เริ่มต้น",
    "agent": "เอเจนต์ในเครื่อง",
    "selectAgent": "เลือกเอเจนต์",
    "agentRequired": "เลือกเอเจนต์ในเครื่องที่พร้อมใช้งานก่อน",
    "fieldsRequired": "กรอกชื่อโปรเจกต์ URL แผนที่ และความต้องการด้านการออกแบบ",
    "createError": "สร้างโปรเจกต์แผนที่ไม่ได้ โปรดลองอีกครั้ง",
    "chooseDirectory": "เลือกโฟลเดอร์ทำงาน",
    "directorySelected": "เลือกโฟลเดอร์ทำงานแล้ว",
    "directoryError": "เลือกโฟลเดอร์ทำงานไม่ได้"
  },
  "ar": {
    "useDefaultMap": "استخدام الخريطة الافتراضية",
    "agent": "وكيل محلي",
    "selectAgent": "اختر وكيلًا",
    "agentRequired": "اختر أولًا وكيلًا محليًا متاحًا.",
    "fieldsRequired": "أكمل اسم المشروع ورابط الخريطة ومتطلبات التصميم.",
    "createError": "تعذر إنشاء المشروع. حاول مجددًا.",
    "chooseDirectory": "اختيار مجلد العمل",
    "directorySelected": "تم اختيار مجلد العمل.",
    "directoryError": "تعذر اختيار مجلد العمل."
  },
  "fa": {
    "useDefaultMap": "استفاده از نقشه پیش‌فرض",
    "agent": "عامل محلی",
    "selectAgent": "انتخاب عامل",
    "agentRequired": "ابتدا یک عامل محلی در دسترس انتخاب کنید.",
    "fieldsRequired": "نام پروژه، نشانی نقشه و نیاز طراحی را تکمیل کنید.",
    "createError": "ساخت پروژه ممکن نیست. دوباره تلاش کنید.",
    "chooseDirectory": "انتخاب پوشه کاری",
    "directorySelected": "پوشه کاری انتخاب شد.",
    "directoryError": "انتخاب پوشه کاری ممکن نیست."
  }
};
