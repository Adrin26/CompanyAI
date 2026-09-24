import sqlite3
import jwt
from datetime import datetime, timedelta
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import OAuth2PasswordBearer
from redis import Redis

DB_PATH = "antigravity_data.db"

# Initialize SQLite database and default admin user if not exists
def init_auth_db():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                hashed_password TEXT NOT NULL
            )
        ''')
        cursor.execute("SELECT id FROM users WHERE username='admin'")
        if not cursor.fetchone():
            pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
            cursor.execute(
                "INSERT INTO users (username, hashed_password) VALUES (?, ?)", 
                ("admin", pwd_ctx.hash("password123"))
            )
        conn.commit()

init_auth_db()

def get_user_from_db(username: str):
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, hashed_password FROM users WHERE username = ?", (username,))
        return cursor.fetchone()

def get_redis_client():
    try:
        client = Redis(host='localhost', port=6379, db=1, decode_responses=True, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None

# Security config
SECRET_KEY = "super-secret-key-for-now"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    # 1. Fast-path: Check Redis cache if available
    redis_client = get_redis_client()
    if redis_client:
        try:
            cached_user = redis_client.get(f"session:{token}")
            if cached_user:
                return cached_user
        except Exception:
            pass
        
    # 2. Verify token and check SQLite database
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception
        
    user = get_user_from_db(username)
    if user is None:
        raise credentials_exception
        
    # 3. Cache the validated session in Redis for fast access
    if redis_client:
        try:
            redis_client.setex(f"session:{token}", 300, username)
        except Exception:
            pass

    return username

