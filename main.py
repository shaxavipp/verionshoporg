import os
import psycopg2
from starkerak import StarKerakClient

# 1. Bazaga ulanish
DATABASE_URL = os.environ['DATABASE_URL']
conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor()

# 2. Clientni ishga tushirish
client = StarKerakClient("7bshDqG6hefSUPewpPcL8jmuM4uoCk27jtAL1sSfHks") # API kalitingiz

@client.on_payment
async def pull_keldi(payment):
    amount = payment['amount']
    # Mijoz to'lov qilganda izohga yozgan ID raqamini olamiz
    # Eslatma: payment['comment'] yoki shunga o'xshash maydon bo'lishi kerak
    user_id = payment.get('comment', '0') 
    
    print(f"Yangi to'lov: {amount} so'm. Mijoz ID: {user_id}")

    try:
        # 3. Bazada balansni oshirish
        cur.execute("UPDATE users SET balance = balance + %s WHERE id = %s", (amount, user_id))
        conn.commit()
        print("Balans muvaffaqiyatli yangilandi!")
    except Exception as e:
        print(f"Xatolik yuz berdi: {e}")

client.start_listening()