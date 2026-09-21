import type { Locale } from '../types';
import { apiProfilesCopy } from './api-profiles';
const messages: Record<Locale, Record<'auth' | 'rate' | 'timeout' | 'model' | 'incomplete' | 'busy' | 'changed', string>> = {
  "en": {
    "auth": "Authentication was rejected. Check the API key and its permissions.",
    "rate": "The service is rate-limiting requests. Try again later.",
    "timeout": "The test timed out after 30 seconds. Check network access and the endpoint.",
    "model": "The endpoint or model was not found. Check the base URL, response format and model ID.",
    "incomplete": "No complete text response was received within the test budget. Check model compatibility.",
    "busy": "A test is already running or was just completed. Wait a few seconds.",
    "changed": "The configuration changed during testing. Save and test the latest version."
  },
  "zh-CN": {
    "auth": "身份验证失败，请检查 API 密钥及其权限。",
    "rate": "服务暂时限制了请求频率，请稍后重试。",
    "timeout": "测试超过 30 秒，请检查网络和接口地址。",
    "model": "未找到接口或模型，请检查基础 URL、响应格式和模型 ID。",
    "incomplete": "测试预算内未收到完整文本响应，请检查模型兼容性。",
    "busy": "已有测试正在进行或刚刚完成，请等待几秒后重试。",
    "changed": "测试期间配置已变更，请保存并重新测试最新配置。"
  },
  "zh-TW": {
    "auth": "身分驗證失敗，請檢查 API 金鑰及其權限。",
    "rate": "服務暫時限制了請求頻率，請稍後重試。",
    "timeout": "測試超過 30 秒，請檢查網路和端點。",
    "model": "找不到端點或模型，請檢查基礎 URL、回應格式和模型 ID。",
    "incomplete": "測試預算內未收到完整文字回應，請檢查模型相容性。",
    "busy": "已有測試正在進行或剛完成，請等候幾秒後重試。",
    "changed": "測試期間設定已變更，請儲存並重新測試最新設定。"
  },
  "de": {
    "auth": "Authentifizierung fehlgeschlagen. API-Schlüssel und Berechtigungen prüfen.",
    "rate": "Der Dienst begrenzt Anfragen. Später erneut versuchen.",
    "timeout": "Zeitüberschreitung nach 30 Sekunden. Netzwerk und Endpunkt prüfen.",
    "model": "Endpunkt oder Modell nicht gefunden. URL, Antwortformat und Modell-ID prüfen.",
    "incomplete": "Keine vollständige Textantwort im Testbudget. Modellkompatibilität prüfen.",
    "busy": "Ein Test läuft oder wurde gerade beendet. Einige Sekunden warten.",
    "changed": "Konfiguration während des Tests geändert. Neueste Version speichern und testen."
  },
  "fr": {
    "auth": "Authentification refusée. Vérifiez la clé API et ses droits.",
    "rate": "Le service limite les requêtes. Réessayez plus tard.",
    "timeout": "Délai de 30 secondes dépassé. Vérifiez le réseau et l’adresse.",
    "model": "Adresse ou modèle introuvable. Vérifiez URL, format et ID du modèle.",
    "incomplete": "Aucune réponse complète dans le budget du test. Vérifiez la compatibilité du modèle.",
    "busy": "Un test est en cours ou vient de finir. Attendez quelques secondes.",
    "changed": "Configuration modifiée pendant le test. Enregistrez puis testez la dernière version."
  },
  "es-ES": {
    "auth": "Autenticación rechazada. Revise la clave API y sus permisos.",
    "rate": "El servicio limita las solicitudes. Inténtelo más tarde.",
    "timeout": "Se agotaron los 30 segundos. Revise red y dirección.",
    "model": "No se encontró servicio o modelo. Revise URL, formato e ID.",
    "incomplete": "No hubo respuesta completa dentro del límite. Revise compatibilidad.",
    "busy": "Ya hay una prueba en curso o acaba de terminar. Espere unos segundos.",
    "changed": "La configuración cambió durante la prueba. Guarde y pruebe la versión actual."
  },
  "pt-BR": {
    "auth": "Autenticação rejeitada. Verifique a chave API e permissões.",
    "rate": "O serviço está limitando solicitações. Tente mais tarde.",
    "timeout": "Tempo limite de 30 segundos. Verifique rede e endereço.",
    "model": "Endpoint ou modelo não encontrado. Verifique URL, formato e ID.",
    "incomplete": "Nenhuma resposta completa dentro do limite. Verifique a compatibilidade.",
    "busy": "Um teste está em andamento ou acabou de terminar. Aguarde alguns segundos.",
    "changed": "Configuração alterada durante o teste. Salve e teste a versão atual."
  },
  "it": {
    "auth": "Autenticazione rifiutata. Controlla chiave API e permessi.",
    "rate": "Il servizio limita le richieste. Riprova più tardi.",
    "timeout": "Timeout dopo 30 secondi. Controlla rete e indirizzo.",
    "model": "Endpoint o modello non trovato. Controlla URL, formato e ID.",
    "incomplete": "Nessuna risposta completa entro il limite. Controlla la compatibilità.",
    "busy": "Un test è in corso o appena terminato. Attendi alcuni secondi.",
    "changed": "Configurazione cambiata durante il test. Salva e testa la versione attuale."
  },
  "ja": {
    "auth": "認証に失敗しました。API キーと権限を確認してください。",
    "rate": "リクエストが制限されています。後でもう一度お試しください。",
    "timeout": "30 秒でタイムアウトしました。ネットワークと接続先を確認してください。",
    "model": "接続先またはモデルが見つかりません。URL、応答形式、モデル ID を確認してください。",
    "incomplete": "テスト上限内に完全なテキスト応答がありませんでした。互換性を確認してください。",
    "busy": "テスト実行中または終了直後です。数秒お待ちください。",
    "changed": "テスト中に設定が変更されました。最新の設定を保存して再テストしてください。"
  },
  "ko": {
    "auth": "인증에 실패했습니다. API 키와 권한을 확인하세요.",
    "rate": "서비스가 요청을 제한하고 있습니다. 나중에 다시 시도하세요.",
    "timeout": "30초 시간 초과입니다. 네트워크와 주소를 확인하세요.",
    "model": "주소 또는 모델을 찾을 수 없습니다. URL, 응답 형식, 모델 ID를 확인하세요.",
    "incomplete": "테스트 한도 내에 완전한 응답을 받지 못했습니다. 모델 호환성을 확인하세요.",
    "busy": "테스트 중이거나 방금 끝났습니다. 잠시 기다리세요.",
    "changed": "테스트 중 설정이 변경되었습니다. 최신 설정을 저장하고 다시 테스트하세요."
  },
  "ru": {
    "auth": "Ошибка авторизации. Проверьте ключ API и права.",
    "rate": "Сервис ограничивает запросы. Повторите позже.",
    "timeout": "Истекли 30 секунд. Проверьте сеть и адрес.",
    "model": "Адрес или модель не найдены. Проверьте URL, формат и ID.",
    "incomplete": "Полный ответ не получен в пределах бюджета теста. Проверьте совместимость.",
    "busy": "Тест выполняется или только завершился. Подождите несколько секунд.",
    "changed": "Настройка изменилась во время теста. Сохраните и проверьте актуальную версию."
  },
  "uk": {
    "auth": "Помилка автентифікації. Перевірте ключ API та права.",
    "rate": "Сервіс обмежує запити. Спробуйте пізніше.",
    "timeout": "Минуло 30 секунд. Перевірте мережу та адресу.",
    "model": "Адресу чи модель не знайдено. Перевірте URL, формат та ID.",
    "incomplete": "Повну відповідь у межах тесту не отримано. Перевірте сумісність.",
    "busy": "Тест триває або щойно завершився. Зачекайте кілька секунд.",
    "changed": "Налаштування змінилися під час тесту. Збережіть і перевірте актуальну версію."
  },
  "pl": {
    "auth": "Uwierzytelnianie odrzucone. Sprawdź klucz API i uprawnienia.",
    "rate": "Usługa ogranicza żądania. Spróbuj później.",
    "timeout": "Przekroczono 30 sekund. Sprawdź sieć i adres.",
    "model": "Nie znaleziono adresu lub modelu. Sprawdź URL, format i ID.",
    "incomplete": "Brak pełnej odpowiedzi w limicie testu. Sprawdź zgodność modelu.",
    "busy": "Test trwa lub właśnie się zakończył. Poczekaj kilka sekund.",
    "changed": "Konfiguracja zmieniła się podczas testu. Zapisz i sprawdź aktualną wersję."
  },
  "hu": {
    "auth": "A hitelesítés sikertelen. Ellenőrizze az API-kulcsot és jogosultságokat.",
    "rate": "A szolgáltatás korlátozza a kéréseket. Próbálja később.",
    "timeout": "30 másodperc eltelt. Ellenőrizze a hálózatot és a címet.",
    "model": "A végpont vagy modell nem található. Ellenőrizze az URL-t, formátumot és azonosítót.",
    "incomplete": "Nem érkezett teljes válasz a tesztkereten belül. Ellenőrizze a kompatibilitást.",
    "busy": "Teszt folyik vagy épp befejeződött. Várjon néhány másodpercet.",
    "changed": "A konfiguráció a teszt alatt megváltozott. Mentse és tesztelje az új verziót."
  },
  "id": {
    "auth": "Autentikasi ditolak. Periksa kunci API dan izinnya.",
    "rate": "Layanan membatasi permintaan. Coba lagi nanti.",
    "timeout": "Batas waktu 30 detik terlampaui. Periksa jaringan dan alamat.",
    "model": "Alamat atau model tidak ditemukan. Periksa URL, format respons, dan ID.",
    "incomplete": "Respons lengkap tidak diterima dalam batas uji. Periksa kompatibilitas.",
    "busy": "Pengujian berjalan atau baru selesai. Tunggu beberapa detik.",
    "changed": "Konfigurasi berubah saat pengujian. Simpan dan uji versi terbaru."
  },
  "tr": {
    "auth": "Kimlik doğrulama reddedildi. API anahtarını ve izinlerini kontrol edin.",
    "rate": "Hizmet istekleri sınırlıyor. Daha sonra deneyin.",
    "timeout": "30 saniyelik süre doldu. Ağı ve adresi kontrol edin.",
    "model": "Adres veya model bulunamadı. URL, biçim ve kimliği kontrol edin.",
    "incomplete": "Test bütçesinde tam yanıt alınamadı. Model uyumluluğunu kontrol edin.",
    "busy": "Bir test çalışıyor veya yeni bitti. Birkaç saniye bekleyin.",
    "changed": "Test sırasında yapılandırma değişti. Son sürümü kaydedip test edin."
  },
  "th": {
    "auth": "ยืนยันตัวตนไม่สำเร็จ ตรวจสอบคีย์ API และสิทธิ์",
    "rate": "บริการจำกัดคำขอ โปรดลองภายหลัง",
    "timeout": "หมดเวลา 30 วินาที ตรวจสอบเครือข่ายและที่อยู่",
    "model": "ไม่พบที่อยู่หรือโมเดล ตรวจสอบ URL รูปแบบตอบกลับและ ID",
    "incomplete": "ไม่ได้รับข้อความตอบกลับครบภายในขีดจำกัด ตรวจสอบความเข้ากันได้",
    "busy": "กำลังทดสอบหรือเพิ่งเสร็จ โปรดรอสักครู่",
    "changed": "การตั้งค่าเปลี่ยนระหว่างทดสอบ บันทึกและทดสอบค่าใหม่อีกครั้ง"
  },
  "ar": {
    "auth": "رُفض التوثيق. تحقق من مفتاح API وصلاحياته.",
    "rate": "الخدمة تحدّ الطلبات. أعد المحاولة لاحقًا.",
    "timeout": "انتهت مهلة 30 ثانية. تحقق من الشبكة والعنوان.",
    "model": "لم يُعثر على العنوان أو النموذج. تحقق من URL والتنسيق ومعرّف النموذج.",
    "incomplete": "لم تصل استجابة نصية كاملة ضمن حد الاختبار. تحقق من التوافق.",
    "busy": "يوجد اختبار جارٍ أو انتهى للتو. انتظر بضع ثوانٍ.",
    "changed": "تغير الإعداد أثناء الاختبار. احفظ أحدث نسخة واختبرها."
  },
  "fa": {
    "auth": "احراز هویت رد شد. کلید API و مجوزها را بررسی کنید.",
    "rate": "سرویس درخواست‌ها را محدود کرده است. بعداً تلاش کنید.",
    "timeout": "مهلت ۳۰ ثانیه تمام شد. شبکه و نشانی را بررسی کنید.",
    "model": "نشانی یا مدل پیدا نشد. URL، قالب پاسخ و شناسه را بررسی کنید.",
    "incomplete": "پاسخ کامل در محدودیت آزمایش دریافت نشد. سازگاری مدل را بررسی کنید.",
    "busy": "آزمایشی در حال اجراست یا تازه تمام شده. چند ثانیه صبر کنید.",
    "changed": "تنظیمات در زمان آزمایش تغییر کرد. نسخه جدید را ذخیره و آزمایش کنید."
  }
};
export function apiProfileFailureText(locale: Locale, code: string): string {
  const copy = messages[locale];
  switch (code) {
    case 'API_AUTH_FAILED': return copy.auth;
    case 'API_RATE_LIMITED': return copy.rate;
    case 'API_TEST_TIMEOUT': return copy.timeout;
    case 'API_MODEL_NOT_FOUND': case 'API_PROFILE_NOT_FOUND': return copy.model;
    case 'API_TEST_INCOMPLETE': return copy.incomplete;
    case 'API_TEST_BUSY': return copy.busy;
    case 'API_PROFILE_CHANGED': return copy.changed;
    case 'API_KEY_REQUIRED_FOR_ENDPOINT': return apiProfilesCopy[locale].endpointKey;
    case 'INVALID_INPUT': case 'API_CONFIGURATION_REQUIRED': return apiProfilesCopy[locale].invalid;
    default: return apiProfilesCopy[locale].error;
  }
}
