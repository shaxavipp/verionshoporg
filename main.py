import os
import psycopg2
import requests
import time

# Bazaga ulanish
conn = psycopg2.connect(os.environ['DATABASE_URL'], sslmode='require')
cur = conn.cursor()

API_KEY = "yWjGEHOYemUolmXfTvG03j0Va34qooeKxN4wMpdzu-U" # Kalitingizni shu yerga yozing

print("Monitoring ishga tushdi...")

while True:
    try:
        # Starkerak API'dan to'lovlar ro'yxatini olish
        headers = {"Authorization": f"Bearer {API_KEY}"}
        # URL'ni Starkerak panelidan tekshiring, odatda shunday bo'ladi:
        response = requests.get("https://api.starkerak.uz/v1/payments", headers=headers)
        
        if response.status_code == 200:
            payments = response.json()
            for payment in payments:
                amount = payment.get('amount')
                # Bu yerda to'lovdagi izohni qidiramiz
                user_id = payment.get('comment')
                
                # Agar to'lov bazada hali ishlanmagan bo'lsa
                # (Sizga bazada 'processed' degan ustun qo'shishni maslahat beraman)
                if user_id:
                    cur.execute("UPDATE users SET balance = balance + %s WHERE id = %s", (amount, user_id))
                    conn.commit()
                    print(f"To'lov qabul qilindi: {amount} so'm, ID: {user_id}")
    except Exception as e:
        print(f"Xatolik: {e}")
    
    time.sleep(10) # 10 soniyada bir tekshiradi