import os
import re
import time
import sys
from datetime import date
import io
import requests
import urllib3
from bs4 import BeautifulSoup
from fpdf import FPDF
from google import genai
import streamlit as st
from dotenv import load_dotenv

# 載入環境變數
load_dotenv()

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Streamlit 頁面設定
st.set_page_config(page_title="全台房產成交戰術引擎 7.0 (權威純文字版)", layout="wide")

# --- 文字過濾邏輯 (純文字化，徹底移除 Emoji 與標籤垃圾) ---

def filter_plain_text(text: str) -> str:
    """過濾掉所有非 BMP 字元 (Emoji) 並清洗標籤垃圾"""
    if not text: return ""
    # 移除 Emoji (非 BMP 字元)
    non_bmp_map = dict.fromkeys(range(0x10000, sys.maxunicode + 1), '')
    text = text.translate(non_bmp_map)
    # 將半形括號替換為全形
    text = text.replace('(', '（').replace(')', '）')
    # 移除標籤垃圾 『 』 【 】
    text = re.sub(r'[『』【】]', '', text)
    # 移除常見特殊符號與點陣 Emoji
    text = re.sub(r'[\u2600-\u27BF\u2300-\u23FF]', '', text)
    # 移除星號與井號 (Markdown 殘留)
    text = text.replace("*", "").replace("#", "")
    return text.strip()

# --- PDF 類別定義 (權威純文字版) ---

class TacticalPDF(FPDF):
    def __init__(self, property_name):
        super().__init__()
        self.property_name = property_name
        # 註冊字體 (優先讀取專案目錄下的 msjh.ttc 以支援雲端部署)
        local_font_path = "msjh.ttc"
        system_font_path = r"C:\Windows\Fonts\msjh.ttc"
        
        if os.path.exists(local_font_path):
            font_path = local_font_path
        elif os.path.exists(system_font_path):
            font_path = system_font_path
        else:
            font_path = None
            st.error("系統找不到微軟正黑體 (msjh.ttc)，請確保專案根目錄中包含此字體檔案。")
        
        if font_path:
            self.add_font("MSJH", "", font_path)
            self.add_font("MSJH", "B", font_path)
        
        self.set_auto_page_break(auto=True, margin=10)
        self.set_margins(10, 10, 10) # 左右上下邊距都設為 10mm
        self.set_line_width(0.2) # 線條寬度設為標準細線

    def header(self):
        # 頁首
        self.set_font("MSJH", "", 10)
        self.set_text_color(100, 100, 100)
        self.cell(0, 8, f"全台房產成交策略引擎 - 專家級戰術報告 | 物件：{self.property_name}", border=0, ln=1, align="L")
        self.ln(1)

    def footer(self):
        # 頁尾
        self.set_y(-12)
        self.set_font("MSJH", "", 8)
        self.set_text_color(100, 100, 100)
        page_num = f"第 {self.page_no()} 頁 | 數據需人工確認"
        self.cell(0, 8, page_num, 0, 0, "C")

    def section_title(self, title):
        # 標題樣式：13pt 加粗，下方加一條橫線
        self.ln(2)
        self.set_font("MSJH", "B", 13)
        self.set_text_color(0, 51, 102) # 深藍色文字
        self.cell(0, 7, title, ln=1)
        
        # 畫橫線
        curr_x = self.get_x()
        curr_y = self.get_y()
        self.line(curr_x, curr_y, curr_x + 190, curr_y)
        self.ln(2)
        self.set_text_color(0, 0, 0) # 恢復黑色

    def add_authoritative_paragraph(self, text):
        # 壓縮排版：字體降至 10pt，行高降至 5.5
        self.set_font("MSJH", "", 10)
        
        # 過濾 Emoji 與標籤
        clean_text = filter_plain_text(text)
        
        # 優化斷行：確保數字與單位不被生硬拆分
        # 針對台灣房產常見單位進行物理黏合 (使用非換行空格 \u00A0)
        units = ["坪", "萬", "戶", "樓", "房", "廳", "衛", "年", "元", "公尺"]
        for unit in units:
            # 尋找數字+單位的模式，將中間可能存在的空格替換為非換行空格
            clean_text = re.sub(rf"(\d+)\s*({unit})", r"\1\2", clean_text)
        
        # 使用 multi_cell 並設定 h=5.5 (約為 1.3 倍行高)
        self.multi_cell(0, 5.5, clean_text, align='L')
        self.ln(1) # 段落間距縮減至 1mm

    def add_contact_box(self, name="__________", phone="__________"):
        """在末尾加入商用聯繫區"""
        self.ln(3)
        self.set_font("MSJH", "B", 9)
        self.set_text_color(100, 100, 100)
        self.cell(0, 5, "--------------------------------------------------------------------------------", ln=1, align="R")
        self.cell(0, 5, f"業務聯繫人：{name} / 電話：{phone}", ln=1, align="R")

# --- 核心邏輯函數 ---

def build_prompt(property_description: str) -> str:
    return (
        "你是專業在地房仲，講話權威且直白。現在執行『極致 MVP 收斂』策略，嚴禁幻覺。"
        "\n\n【防幻覺協議】："
        "\n1. 嚴禁推理行情：禁止估算區域均價、禁止計算價差百分比、禁止提到『低於行情幾%』。"
        "\n2. 數據絕對一致：文案中所有數字（總價、單價、坪數、樓層、車位費）必須與輸入資訊 100% 相同，嚴禁發散。"
        "\n3. 物理數據優先：只使用輸入資訊中明確提到的地段、格局、建材、設施。"
        "\n\n輸出結構必須包含以下 4 個區塊（以便系統解析）："
        "\n1. 【物件核心規格與黃金價值】：條列式列出物件最真實的物理優勢（地段、坪效、格局、車位）。"
        "\n2. 【591 專業優化版】：針對 591 平台優化的權威房屋描述。"
        "\n3. 【FB 社團吸粉版】：強力 Hook、口語化、吸睛特點。"
        "\n4. 【LINE/限動秒殺版】：不超過 100 字，強調稀缺與真實數據。"
        f"\n\n待處理真實資訊：{property_description}"
    )

def resolve_input_text(user_input: str) -> tuple[str, str]:
    if "591.com.tw" not in user_input:
        return user_input, ""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    }
    try:
        response = requests.get(user_input, headers=headers, timeout=15, verify=False)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        title = soup.title.get_text(strip=True) if soup.title else ""
        text = soup.get_text(separator=" ", strip=True)
        return text[:2000], title
    except Exception as e:
        st.error(f"解析網址時發生錯誤: {e}")
        return "", ""

def sanitize_filename(value: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]", "_", value)
    cleaned = re.sub(r"\s+", "_", cleaned).strip("_")
    return cleaned or "物件"

def split_inputs(raw_input: str) -> list[str]:
    parts = re.split(r"[,\n]+", raw_input)
    return [item.strip() for item in parts if item.strip()]

def extract_sections(content: str) -> dict[str, str]:
    sections = {
        "核心規格": "",
        "591版": "",
        "FB版": "",
        "LINE版": "",
    }
    
    # 更新切割邏輯以對應新 Prompt
    patterns = {
        "核心規格": r"(【?物件核心規格與黃金價值】?)",
        "591版": r"(【?591\s*(專業)?(優化)?版】?)",
        "FB版": r"(【?FB\s*(社團)?(吸粉)?版】?)",
        "LINE版": r"(【?LINE\s*(/限動)?(秒殺)?版】?)",
    }
    
    lines = content.splitlines()
    current_key = None
    
    for line in lines:
        line_strip = line.strip().replace("*", "").replace("#", "")
        if not line_strip: continue
        
        found_header = False
        for key, pattern in patterns.items():
            if re.search(pattern, line_strip, re.IGNORECASE):
                if len(line_strip) < 40: # 標題通常較短
                    current_key = key
                    found_header = True
                    break
        
        if found_header: continue
        if current_key:
            sections[current_key] += line + "\n"
            
    return sections

def extract_region_and_name(title: str, fallback: str) -> tuple[str, str]:
    region_candidates = ["台北", "新北", "桃園", "台中", "台南", "高雄", "基隆", "新竹", "嘉義", "宜蘭", "花蓮", "台東", "雲林", "彰化", "南投", "屏東", "苗栗"]
    region = "全台"
    for candidate in region_candidates:
        if candidate in title:
            region = candidate
            break
    name_source = title or fallback
    name_source = re.sub(r"591|租|售|買|房屋|物件|出售", "", name_source)
    name_source = re.sub(r"[\[\]\(\)【】]", "", name_source)
    name = sanitize_filename(name_source)[:12] or "物件"
    return region, name

def generate_listing(client: genai.Client, property_description: str) -> str:
    prompt = build_prompt(property_description)
    # 強制升級至 Gemini 3.x 世代模型
    model_sequence = [
        "gemini-3.5-flash",        # 主力模型
        "gemini-3.1-flash-lite",   # 後備防線
    ]
    last_error = ""
    for model_name in model_sequence:
            try:
                response = client.models.generate_content(model=model_name, contents=prompt, config={"temperature": 0.7})
                if response and response.text:
                    return response.text.strip()
            except Exception as e:
                last_error = str(e)
                print(f"AI 模型 {model_name} 生成失敗: {last_error}")
                continue
    
    error_msg = f"所有 AI 模型 (3.5/3.1) 都無法產生內容。\n最後一個錯誤提示：{last_error}"
    if "404" in last_error or "not found" in last_error.lower():
        error_msg += "\n\n💡 提示：模型名稱可能尚未在您的區域開放，或 API 版本需更新。請檢查 Google AI Studio 模型清單。"
    elif "429" in last_error:
        error_msg += "\n\n💡 提示：API 呼叫次數已達上限 (429 Quota Exceeded)。"
    
    raise ValueError(error_msg)

def save_pdf(title: str, content: str, contact_name: str = "__________", contact_phone: str = "__________") -> tuple[str, io.BytesIO]:
    sections = extract_sections(content)
    region, property_name = extract_region_and_name(title, sections["核心規格"][:12])
    
    pdf = TacticalPDF(property_name)
    
    # 第一頁：物件核心規格與黃金價值
    pdf.add_page()
    pdf.section_title("【物件核心規格與黃金價值】")
    spec_text = sections["核心規格"].strip() or "（真實物理數據讀取中...）"
    for line in spec_text.splitlines():
        if line.strip(): pdf.add_authoritative_paragraph(line.strip())
    
    # 第二頁：全渠道成交戰術文案
    pdf.add_page()
    pdf.section_title("【全渠道成交戰術文案】")
    
    # 591 優化版
    pdf.set_font("MSJH", "B", 11)
    pdf.set_text_color(0, 102, 204)
    pdf.cell(0, 6, "◆ 591 專業描述優化版", ln=1)
    pdf.set_text_color(0, 0, 0)
    text_591 = sections["591版"].strip() or "（文案生成中...）"
    for line in text_591.splitlines():
        if line.strip(): pdf.add_authoritative_paragraph(line.strip())
    
    # FB 版
    pdf.ln(1)
    pdf.set_font("MSJH", "B", 11)
    pdf.set_text_color(0, 102, 204)
    pdf.cell(0, 6, "◆ FB 社團爆款版", ln=1)
    pdf.set_text_color(0, 0, 0)
    text_fb = sections["FB版"].strip() or "（文案生成中...）"
    for line in text_fb.splitlines():
        if line.strip(): pdf.add_authoritative_paragraph(line.strip())
    
    # LINE 版
    pdf.ln(1)
    pdf.set_font("MSJH", "B", 11)
    pdf.set_text_color(0, 102, 204)
    pdf.cell(0, 6, "◆ LINE / 限動秒殺版", ln=1)
    pdf.set_text_color(0, 0, 0)
    text_line = sections["LINE版"].strip() or "（文案生成中...）"
    for line in text_line.splitlines():
        if line.strip(): pdf.add_authoritative_paragraph(line.strip())
    
    # 末尾聯繫區
    pdf.ln(1)
    pdf.add_contact_box(contact_name, contact_phone)
    
    filename = f"【成交戰術】{region}_{property_name}.pdf"
    output_dir = os.path.join(os.getcwd(), "Outputs")
    os.makedirs(output_dir, exist_ok=True)
    
    pdf_bytes = pdf.output()
    with open(os.path.join(output_dir, filename), "wb") as f:
        f.write(pdf_bytes)
    
    bio = io.BytesIO(pdf_bytes)
    return filename, bio

# --- Streamlit UI ---

def main():
    # 1. 初始化 Session State (頁面最上方)
    if 'generated' not in st.session_state:
        st.session_state.generated = False
    if 'results' not in st.session_state:
        st.session_state.results = []
    if 'user_input' not in st.session_state:
        st.session_state.user_input = ""

    st.title("全台房產成交戰術引擎 7.0 (權威純文字版)")
    st.markdown("---")
    
    # 使用 session_state.user_input 作為初始值
    user_input = st.text_area("請貼上 591 網址或房屋描述：", height=200, key="user_input_area", value=st.session_state.user_input)
    
    col_name, col_phone = st.columns(2)
    with col_name:
        contact_name = st.text_input("您的稱呼（將印於 PDF 底部）：", placeholder="例如：王小明 經理")
    with col_phone:
        contact_phone = st.text_input("您的聯絡電話：", placeholder="例如：0912-345-678")

    if st.button("🚀 執行重構生成", key="generate_button"):
        st.session_state.user_input = user_input # 保存輸入內容
        if not user_input.strip(): return
        
        # 優先從環境變數讀取，若無則嘗試 st.secrets
        api_key = os.getenv("GEMINI_API_KEY") or st.secrets.get("GEMINI_API_KEY")
        if not api_key: 
            st.error("❌ 找不到 API KEY：請在 .env 檔案或 Streamlit Secrets 中設定 GEMINI_API_KEY")
            return
        
        # 重置生成狀態，防止舊數據干擾
        st.session_state.generated = False
        st.session_state.results = []
        
        client = genai.Client(api_key=api_key)
        inputs = split_inputs(user_input)
        
        progress_bar = st.progress(0)
        current_results = []
        
        success_count = 0
        for idx, item in enumerate(inputs):
            try:
                progress_bar.progress((idx + 1) / len(inputs))
                desc, title = resolve_input_text(item)
                if not desc: continue
                
                output = generate_listing(client, desc)
                # 傳入動態聯繫人資訊
                fname, bio = save_pdf(
                    title or desc[:12], 
                    output, 
                    contact_name=contact_name or "__________", 
                    contact_phone=contact_phone or "__________"
                )
                
                # 解析區塊用於預覽
                sections = extract_sections(output)
                
                current_results.append({
                    "title": title or desc[:12],
                    "filename": fname,
                    "pdf_data": bio.getvalue(), # 存儲二進位數據
                    "content": output,
                    "sections": sections
                })
                success_count += 1
            except Exception as e:
                # 發生錯誤時，顯示詳細紅框報錯
                st.error(f"⚠️ 生成過程發生錯誤：{e}")
                # 發生錯誤即重置狀態，確保 UI 不會停留在錯誤的快取
                st.session_state.generated = False
                st.session_state.results = []
        
        progress_bar.empty()
        
        if success_count > 0:
            # 只有在有成功生成結果時才更新狀態並觸發 rerun
            st.session_state.results = current_results
            st.session_state.text_result = current_results[0]['content'] 
            st.session_state.generated = True
            st.rerun() 
        else:
            st.warning("⚠️ 未能生成任何內容。請檢查輸入網址是否有效，或確認 API 配額是否充足。")

    # 2. 渲染防禦線：只要 generated 為 True 就必須完整顯示
    if st.session_state.generated and st.session_state.results:
        st.markdown("### 📄 專家級戰術報告已就緒")
        for idx, res in enumerate(st.session_state.results):
            # 確保 key 的唯一性與穩定性
            stable_key = f"res_{idx}_{res['filename']}"
            
            with st.expander(f"報告預覽：{res['title']}", expanded=True):
                # 下載按鈕 (純粹 PDF)
                st.download_button(
                    label=f"📥 下載成交戰術 PDF 報告", 
                    data=res['pdf_data'], 
                    file_name=res['filename'], 
                    mime="application/pdf", 
                    key=f"dl_pdf_{stable_key}_{time.time()}"
                )
                
                st.markdown("#### 快速複製區")
                c1, c2, c3 = st.columns(3)
                with c1:
                    st.markdown("**591 專業版**")
                    st.code(res['sections']["591版"], language=None)
                with c2:
                    st.markdown("**FB 社團版**")
                    st.code(res['sections']["FB版"], language=None)
                with c3:
                    st.markdown("**LINE 秒殺版**")
                    line_copy_with_guidance = res['sections']["LINE版"] + "\n\n完整數據偵察報告已生成 PDF，建議上傳至記事本供客戶隨時查閱。"
                    st.code(line_copy_with_guidance, language=None)
                
                st.markdown("---")
                st.markdown(res['content'])

if __name__ == "__main__":
    main()
