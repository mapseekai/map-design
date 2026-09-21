import type { Locale } from '../types';

export const resourceErrorCopy: Record<Locale, { resource: string; 'rate-limit': string }> = {
  "en": {
    "resource": "Some map resources are unavailable. You can continue using the loaded map.",
    "rate-limit": "The map service is rate-limiting requests (HTTP 429). Wait before retrying."
  },
  "zh-CN": {
    "resource": "部分地图资源暂时无法加载，已加载的地图仍可使用。",
    "rate-limit": "地图服务暂时限制了请求频率（HTTP 429），请稍后重试。"
  },
  "zh-TW": {
    "resource": "部分地圖資源暫時無法載入，已載入的地圖仍可使用。",
    "rate-limit": "地圖服務暫時限制了請求頻率（HTTP 429），請稍後重試。"
  },
  "de": {
    "resource": "Einige Kartenressourcen sind nicht verfügbar. Die geladene Karte bleibt nutzbar.",
    "rate-limit": "Der Kartendienst begrenzt Anfragen (HTTP 429). Bitte vor einem erneuten Versuch warten."
  },
  "fr": {
    "resource": "Certaines ressources sont indisponibles. La carte chargée reste utilisable.",
    "rate-limit": "Le service cartographique limite les requêtes (HTTP 429). Patientez avant de réessayer."
  },
  "es-ES": {
    "resource": "Algunos recursos no están disponibles. Puede seguir usando el mapa cargado.",
    "rate-limit": "El servicio de mapas limita las solicitudes (HTTP 429). Espere antes de reintentar."
  },
  "pt-BR": {
    "resource": "Alguns recursos estão indisponíveis. O mapa carregado continua utilizável.",
    "rate-limit": "O serviço de mapas limita as solicitações (HTTP 429). Aguarde antes de tentar novamente."
  },
  "it": {
    "resource": "Alcune risorse non sono disponibili. La mappa caricata resta utilizzabile.",
    "rate-limit": "Il servizio limita le richieste (HTTP 429). Attendi prima di riprovare."
  },
  "ja": {
    "resource": "一部の地図リソースを読み込めません。読み込み済みの地図は引き続き利用できます。",
    "rate-limit": "地図サービスがリクエストを制限しています（HTTP 429）。しばらくしてから再試行してください。"
  },
  "ko": {
    "resource": "일부 지도 리소스를 사용할 수 없습니다. 로드된 지도는 계속 사용할 수 있습니다.",
    "rate-limit": "지도 서비스에서 요청을 제한하고 있습니다(HTTP 429). 잠시 후 다시 시도하세요."
  },
  "ru": {
    "resource": "Некоторые ресурсы недоступны. Загруженной картой можно продолжать пользоваться.",
    "rate-limit": "Сервис карт ограничивает запросы (HTTP 429). Подождите перед повторной попыткой."
  },
  "uk": {
    "resource": "Деякі ресурси недоступні. Завантаженою мапою можна користуватися далі.",
    "rate-limit": "Сервіс мап обмежує запити (HTTP 429). Зачекайте перед повторною спробою."
  },
  "pl": {
    "resource": "Niektóre zasoby są niedostępne. Załadowana mapa pozostaje użyteczna.",
    "rate-limit": "Usługa map ogranicza żądania (HTTP 429). Poczekaj przed ponowną próbą."
  },
  "hu": {
    "resource": "Egyes térképerőforrások nem érhetők el. A betöltött térkép tovább használható.",
    "rate-limit": "A térképszolgáltatás korlátozza a kéréseket (HTTP 429). Várjon az újrapróbálkozás előtt."
  },
  "id": {
    "resource": "Sebagian sumber daya peta tidak tersedia. Peta yang dimuat tetap dapat digunakan.",
    "rate-limit": "Layanan peta membatasi permintaan (HTTP 429). Tunggu sebelum mencoba lagi."
  },
  "tr": {
    "resource": "Bazı harita kaynakları kullanılamıyor. Yüklenen haritayı kullanmaya devam edebilirsiniz.",
    "rate-limit": "Harita hizmeti istekleri sınırlıyor (HTTP 429). Yeniden denemeden önce bekleyin."
  },
  "fa": {
    "resource": "برخی منابع نقشه در دسترس نیستند. می‌توانید از نقشه بارگذاری‌شده استفاده کنید.",
    "rate-limit": "سرویس نقشه درخواست‌ها را محدود کرده است (HTTP 429). پیش از تلاش مجدد صبر کنید."
  },
  "ar": {
    "resource": "بعض موارد الخريطة غير متاحة. يمكنك متابعة استخدام الخريطة المحملة.",
    "rate-limit": "خدمة الخرائط تحد عدد الطلبات (HTTP 429). انتظر قبل إعادة المحاولة."
  },
  "th": {
    "resource": "ทรัพยากรแผนที่บางส่วนไม่พร้อมใช้งาน คุณยังใช้แผนที่ที่โหลดแล้วได้",
    "rate-limit": "บริการแผนที่จำกัดคำขอ (HTTP 429) โปรดรอก่อนลองอีกครั้ง"
  }
};
